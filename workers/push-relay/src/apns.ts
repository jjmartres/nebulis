/**
 * Sending one notification to Apple's push service (APNs).
 *
 * Apple wants an HTTP/2 POST with a short-lived provider token: an ES256 JWT signed by the account's push key (.p8).
 * Apple rejects a token minted more than once every 20 minutes or kept past 60, so it is minted once and reused for
 * 40. That cache is shared by every request on purpose: it is the relay's own credential, not anything a caller sent.
 */
import { toBase64Url } from './credential';

export type ApnsEnv = 'production' | 'sandbox';

const HOSTS: Record<ApnsEnv, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

const TOKEN_MAX_AGE_MS = 40 * 60 * 1000;

export interface ApnsConfig {
  APNS_KEY_P8: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_TOPIC: string;
}

export interface ApnsMessage {
  token: string;
  apnsEnv: ApnsEnv;
  /** The JSON body Apple receives. Already validated and size-checked by the caller. */
  payload: object;
  /** Seconds Apple keeps trying while the phone is off, so a stale "clear night" never arrives the next day. */
  ttlSeconds: number;
  /** A newer notification with the same id replaces an older one still waiting. */
  collapseId?: string;
  /** `background` is silent: Apple checks the token and the app is woken, but nothing is shown. */
  pushType?: 'alert' | 'background';
}

export type ApnsOutcome =
  | { kind: 'sent' }
  /** Apple says this token is dead or not for this app: the caller should forget it. */
  | { kind: 'unregistered' }
  /** Apple (or the network to it) is busy; trying again later is right. */
  | { kind: 'unavailable' }
  /** Our own configuration or key is wrong. Nothing a caller can fix. */
  | { kind: 'misconfigured'; reason: string };

interface ProviderToken { jwt: string; mintedAt: number; keyId: string; teamId: string }
let providerToken: ProviderToken | null = null;

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]*-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), c => c.charCodeAt(0)).buffer;
}

async function mintProviderToken(config: ApnsConfig, now: number): Promise<ProviderToken> {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(config.APNS_KEY_P8), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const encode = (value: object) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: 'ES256', kid: config.APNS_KEY_ID })}.${encode({ iss: config.APNS_TEAM_ID, iat: Math.floor(now / 1000) })}`;
  // WebCrypto returns the raw r||s signature, which is what a JWT carries.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return { jwt: `${unsigned}.${toBase64Url(signature)}`, mintedAt: now, keyId: config.APNS_KEY_ID, teamId: config.APNS_TEAM_ID };
}

async function currentProviderToken(config: ApnsConfig, now: number, fresh: boolean): Promise<string> {
  const usable = providerToken
    && !fresh
    && now - providerToken.mintedAt < TOKEN_MAX_AGE_MS
    && providerToken.keyId === config.APNS_KEY_ID
    && providerToken.teamId === config.APNS_TEAM_ID;
  if (!usable) providerToken = await mintProviderToken(config, now);
  return providerToken!.jwt;
}

/** For tests: forget the cached provider token. */
export function resetProviderToken(): void {
  providerToken = null;
}

async function post(config: ApnsConfig, message: ApnsMessage, jwt: string, now: number): Promise<{ status: number; reason: string }> {
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    'apns-topic': config.APNS_TOPIC,
    'apns-push-type': message.pushType ?? 'alert',
    // Apple requires priority 5 for a background push, and 10 is right for something a person should see now.
    'apns-priority': message.pushType === 'background' ? '5' : '10',
    'apns-expiration': String(Math.floor(now / 1000) + message.ttlSeconds),
    'content-type': 'application/json',
  };
  if (message.collapseId) headers['apns-collapse-id'] = message.collapseId;
  const response = await fetch(`${HOSTS[message.apnsEnv]}/3/device/${message.token}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(message.payload),
  });
  if (response.status === 200) return { status: 200, reason: '' };
  let reason = '';
  try { reason = String(((await response.json()) as { reason?: unknown }).reason ?? ''); } catch { /* an empty body is fine */ }
  return { status: response.status, reason };
}

const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);
const STALE_PROVIDER_TOKEN_REASONS = new Set(['ExpiredProviderToken', 'InvalidProviderToken']);

export async function sendToApns(config: ApnsConfig, message: ApnsMessage, now = Date.now()): Promise<ApnsOutcome> {
  // Our own key failing to load is a setup problem, kept apart from Apple being unreachable.
  let jwt: string;
  try {
    jwt = await currentProviderToken(config, now, false);
  } catch {
    return { kind: 'misconfigured', reason: 'key' };
  }
  let result: { status: number; reason: string };
  try {
    result = await post(config, message, jwt, now);
    // A token Apple calls expired or invalid may only be stale on our side: mint one fresh and try once more.
    if (result.status === 403 && STALE_PROVIDER_TOKEN_REASONS.has(result.reason)) {
      result = await post(config, message, await currentProviderToken(config, now, true), now);
    }
  } catch {
    return { kind: 'unavailable' };
  }
  if (result.status === 200) return { kind: 'sent' };
  if (result.status === 410 || DEAD_TOKEN_REASONS.has(result.reason)) return { kind: 'unregistered' };
  if (result.status === 429 || result.status >= 500) return { kind: 'unavailable' };
  return { kind: 'misconfigured', reason: result.reason || `http-${result.status}` };
}
