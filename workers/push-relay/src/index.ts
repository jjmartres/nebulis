/**
 * Nebulis push relay: turns a Nebulis server's alert into a push notification on a person's iPhone.
 *
 * Why it exists: Apple only accepts pushes from the app maker's account, and its key cannot ship inside software
 * people host themselves. This Worker holds the key and nothing else. It stores no tokens, no messages and no
 * accounts, and it logs no tokens or message text.
 *
 *   POST /v1/register  a phone's device token in, a credential out (after Apple confirms the token is real)
 *   POST /v1/push      token + credential + a short message in, one notification out
 *   GET  /health
 */
import { sendToApns, type ApnsConfig, type ApnsOutcome } from './apns';
import { issueCredential, verifyCredential } from './credential';
import { MAX_BODY_BYTES, parsePush, parseRegister, readJson } from './validate';

const REGISTER_TTL_SECONDS = 600;

function json(status: number, body: object, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // Tell clients that have reached this host over https never to try it over plain http again.
      'strict-transport-security': 'max-age=31536000',
      ...headers,
    },
  });
}

/** One structured line per request. Status and reason codes only: never a token, a credential or message text. */
function log(event: string, fields: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function apnsConfig(env: Env): ApnsConfig {
  return { APNS_KEY_P8: env.APNS_KEY_P8, APNS_KEY_ID: env.APNS_KEY_ID, APNS_TEAM_ID: env.APNS_TEAM_ID, APNS_TOPIC: env.APNS_TOPIC };
}

/** What a caller is told about Apple's answer. Never Apple's own text. */
function answer(outcome: ApnsOutcome): Response | null {
  switch (outcome.kind) {
    case 'sent': return null;
    case 'unregistered': return json(410, { error: 'unregistered' });
    case 'unavailable': return json(503, { error: 'unavailable' }, { 'retry-after': '30' });
    case 'misconfigured':
      log('relay_misconfigured', { reason: outcome.reason });
      return json(502, { error: 'relay_error' });
  }
}

function tooMany(): Response {
  return json(429, { error: 'rate_limited' }, { 'retry-after': '60' });
}

const BODY_ERRORS: Record<string, number> = { unsupported_media_type: 415, too_large: 413, bad_request: 400 };

async function register(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!(await env.REGISTER_IP_LIMIT.limit({ key: `ip:${ip}` })).success) return tooMany();

  const input = await readJson(request);
  if (!input.ok) return json(BODY_ERRORS[input.error] ?? 400, { error: input.error });
  const parsed = parseRegister(input.value);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const { token, apnsEnv, title, body } = parsed.value;

  // Apple is the judge of whether this is a real token for this app: a push either lands or is refused. With a title
  // and body the phone shows them (the first time, as a confirmation); without, the check is silent, so the app can
  // renew its credential in the background without buzzing.
  const visible = title !== undefined && body !== undefined;
  const outcome = await sendToApns(apnsConfig(env), {
    token, apnsEnv, ttlSeconds: REGISTER_TTL_SECONDS, collapseId: 'nebulis-register',
    pushType: visible ? 'alert' : 'background',
    payload: visible ? { aps: { alert: { title, body }, sound: 'default' } } : { aps: { 'content-available': 1 } },
  });
  if (outcome.kind === 'unregistered') return json(400, { error: 'invalid_token' });
  const failed = answer(outcome);
  if (failed) return failed;

  log('registered', { env: apnsEnv });
  return json(200, { credential: await issueCredential(env.CREDENTIAL_SECRET, apnsEnv, token) });
}

async function push(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!(await env.PUSH_IP_LIMIT.limit({ key: `ip:${ip}` })).success) return tooMany();

  const input = await readJson(request);
  if (!input.ok) return json(BODY_ERRORS[input.error] ?? 400, { error: input.error });
  const parsed = parsePush(input.value);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const req = parsed.value;

  // Checked before Apple is ever contacted, so a made-up token costs nothing and teaches Apple nothing.
  if (!(await verifyCredential(env.CREDENTIAL_SECRET, req.apnsEnv, req.token, req.credential))) {
    log('push_refused', { reason: 'credential' });
    return json(403, { error: 'forbidden' });
  }
  if (!(await env.PUSH_TOKEN_LIMIT.limit({ key: `tok:${await digest(req.token)}` })).success) return tooMany();

  const payload = {
    aps: { alert: { title: req.title, ...(req.subtitle ? { subtitle: req.subtitle } : {}), body: req.body }, sound: 'default', ...(req.threadId ? { 'thread-id': req.threadId } : {}) },
    ...(req.link ? { link: req.link } : {}),
  };
  // Apple refuses more than 4 KB; the title and body limits keep us far below it, but the cap is the guarantee.
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_BODY_BYTES) return json(413, { error: 'too_large' });

  const outcome = await sendToApns(apnsConfig(env), {
    token: req.token, apnsEnv: req.apnsEnv, ttlSeconds: req.ttlSeconds, collapseId: req.collapseId, payload,
  });
  const failed = answer(outcome);
  if (failed) {
    log('push_failed', { env: req.apnsEnv, outcome: outcome.kind });
    return failed;
  }
  log('pushed', { env: req.apnsEnv });
  return json(200, { ok: true });
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const { pathname } = url;
      // A token and a credential must never cross the network in the clear. Cloudflare serves a custom domain over
      // plain http unless the zone says otherwise, so the Worker refuses it itself, before reading anything. Only
      // `wrangler dev` on this machine is allowed to use http.
      if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) {
        if (request.method === 'GET' || request.method === 'HEAD') {
          return new Response(null, { status: 308, headers: { location: `https://${url.host}${pathname}${url.search}` } });
        }
        return json(403, { error: 'https_required' });
      }
      if (pathname === '/health') return request.method === 'GET' ? json(200, { ok: true }) : json(405, { error: 'method_not_allowed' }, { allow: 'GET' });
      if (pathname === '/v1/register' || pathname === '/v1/push') {
        if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
        return pathname === '/v1/register' ? await register(request, env) : await push(request, env);
      }
      return json(404, { error: 'not_found' });
    } catch (error) {
      log('unhandled', { error: error instanceof Error ? error.name : 'unknown' });
      return json(500, { error: 'internal' });
    }
  },
} satisfies ExportedHandler<Env>;
