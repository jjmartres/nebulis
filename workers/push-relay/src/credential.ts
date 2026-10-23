/**
 * The credential a phone gets when it registers, and a Nebulis server presents with every push.
 *
 * It is an HMAC of the device token (and which Apple environment it belongs to) under a secret only this Worker
 * knows, so nothing needs to be stored: the Worker recomputes it. What it buys:
 *   - A token that never registered cannot be pushed to. Garbage cannot be sprayed through the relay at Apple, whose
 *     push service marks a sender that keeps sending to dead tokens.
 *   - Rotating CREDENTIAL_SECRET cuts off every credential at once.
 * It is not a login: whoever holds a device token can register it. A token is 32 random bytes from Apple, known
 * only to the phone and the person's own server.
 */
import type { ApnsEnv } from './apns';

const VERSION = 'v1';
const encoder = new TextEncoder();

function importKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

function signedBytes(apnsEnv: ApnsEnv, token: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`nebulis-push|${VERSION}|${apnsEnv}|${token.toLowerCase()}`);
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function issueCredential(secret: string, apnsEnv: ApnsEnv, token: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await importKey(secret, ['sign']), signedBytes(apnsEnv, token));
  return `${VERSION}.${toBase64Url(signature)}`;
}

/** Constant-time: `subtle.verify` compares the MAC without an early exit. */
export async function verifyCredential(secret: string, apnsEnv: ApnsEnv, token: string, credential: string): Promise<boolean> {
  const [version, encoded, ...rest] = credential.split('.');
  if (version !== VERSION || !encoded || rest.length > 0) return false;
  const signature = fromBase64Url(encoded);
  if (!signature) return false;
  return crypto.subtle.verify('HMAC', await importKey(secret, ['verify']), signature, signedBytes(apnsEnv, token));
}
