/**
 * Everything that arrives is untrusted. Each reader returns the cleaned value or a short error code; nothing is
 * passed to Apple or echoed back that did not come through here.
 */
import type { ApnsEnv } from './apns';

export const MAX_BODY_BYTES = 4096;
const TTL_DEFAULT = 3 * 3600;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Reads the body as JSON without ever holding more than `limit` bytes. */
export async function readJson(request: Request, limit = MAX_BODY_BYTES): Promise<Parsed<Record<string, unknown>>> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return fail('unsupported_media_type');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return fail('too_large');
  if (!request.body) return fail('bad_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return fail('too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('bad_request');
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return fail('bad_request');
  }
}

const TOKEN = /^[0-9a-f]{64,200}$/i;
const ID = /^[A-Za-z0-9._:-]{1,64}$/;
// Everything below a space except tab and newline, plus DEL.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function parseToken(value: unknown): Parsed<string> {
  return typeof value === 'string' && TOKEN.test(value) ? { ok: true, value: value.toLowerCase() } : fail('bad_token');
}

export function parseEnv(value: unknown): Parsed<ApnsEnv> {
  return value === 'production' || value === 'sandbox' ? { ok: true, value } : fail('bad_env');
}

function text(value: unknown, max: number, required: boolean): Parsed<string | undefined> {
  if (value === undefined || value === null) return required ? fail('bad_text') : { ok: true, value: undefined };
  if (typeof value !== 'string') return fail('bad_text');
  const clean = value.replace(CONTROL, '').trim();
  if (clean.length === 0) return required ? fail('bad_text') : { ok: true, value: undefined };
  if ([...clean].length > max) return fail('bad_text');
  return { ok: true, value: clean };
}

export interface RegisterRequest { token: string; apnsEnv: ApnsEnv; title?: string; body?: string }
export interface PushRequest {
  token: string;
  apnsEnv: ApnsEnv;
  credential: string;
  title: string;
  /** The line under the title: the answer, when a notification has one. Optional, so older servers that never send it keep working. */
  subtitle?: string;
  body: string;
  link?: string;
  threadId?: string;
  collapseId?: string;
  ttlSeconds: number;
}

export function parseRegister(input: Record<string, unknown>): Parsed<RegisterRequest> {
  const token = parseToken(input.token); if (!token.ok) return token;
  const apnsEnv = parseEnv(input.env); if (!apnsEnv.ok) return apnsEnv;
  const title = text(input.title, 100, false); if (!title.ok) return title;
  const body = text(input.body, 300, false); if (!body.ok) return body;
  // Both or neither: half a notification is a mistake, not a silent check.
  if ((title.value === undefined) !== (body.value === undefined)) return fail('bad_text');
  return { ok: true, value: { token: token.value, apnsEnv: apnsEnv.value, title: title.value, body: body.value } };
}

export function parsePush(input: Record<string, unknown>): Parsed<PushRequest> {
  const token = parseToken(input.token); if (!token.ok) return token;
  const apnsEnv = parseEnv(input.env); if (!apnsEnv.ok) return apnsEnv;
  if (typeof input.credential !== 'string' || input.credential.length === 0 || input.credential.length > 200) return fail('bad_credential');
  const title = text(input.title, 100, true); if (!title.ok) return title;
  const subtitle = text(input.subtitle, 100, false); if (!subtitle.ok) return subtitle;
  const body = text(input.body, 300, true); if (!body.ok) return body;

  // A link may only open Nebulis itself. Anything else could take the person to a page chosen by a stranger.
  let link: string | undefined;
  if (input.link !== undefined) {
    if (typeof input.link !== 'string' || input.link.length > 200 || !/^nebulis:\/\/[\x21-\x7e]*$/.test(input.link)) return fail('bad_link');
    link = input.link;
  }
  const idField = (value: unknown): Parsed<string | undefined> =>
    value === undefined ? { ok: true, value: undefined } : typeof value === 'string' && ID.test(value) ? { ok: true, value } : fail('bad_id');
  const threadId = idField(input.threadId); if (!threadId.ok) return threadId;
  const collapseId = idField(input.collapseId); if (!collapseId.ok) return collapseId;

  let ttlSeconds = TTL_DEFAULT;
  if (input.ttlSeconds !== undefined) {
    if (typeof input.ttlSeconds !== 'number' || !Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 86400) return fail('bad_ttl');
    ttlSeconds = input.ttlSeconds;
  }
  return {
    ok: true,
    value: {
      token: token.value, apnsEnv: apnsEnv.value, credential: input.credential,
      title: title.value!, subtitle: subtitle.value, body: body.value!, link: link, threadId: threadId.value, collapseId: collapseId.value, ttlSeconds,
    },
  };
}
