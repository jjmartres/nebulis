/**
 * Alert channels and options, in the `alertChannels` / `alertState` tables.
 *
 * Channel URLs and signing secrets are encrypted at rest (secretBox): a
 * Discord or Slack webhook URL is itself the credential, and an ntfy topic
 * name is often the only thing keeping it private.
 */
import { randomUUID } from 'crypto';
import db from '../db.js';
import { decrypt, encrypt } from '../crypto/secretBox.js';
import {
  ALERT_CHANNEL_KINDS,
  ALERT_EVENTS,
  ALERT_LANGUAGES,
  DEFAULT_ALERT_CONFIG,
  type AlertChannel,
  type AlertChannelKind,
  type AlertConfig,
  type AlertEventType,
} from './types.js';

interface ChannelRow {
  id: string;
  name: string;
  kind: string;
  url: string;
  secret: string | null;
  events: string;
  enabled: number;
  createdAt: string;
  lastSentAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

const stmts = {
  all: db.prepare<[], ChannelRow>('SELECT * FROM alertChannels ORDER BY createdAt, id'),
  get: db.prepare<[string], ChannelRow>('SELECT * FROM alertChannels WHERE id = ?'),
  insert: db.prepare(
    `INSERT INTO alertChannels (id, name, kind, url, secret, events, enabled, createdAt)
     VALUES (@id, @name, @kind, @url, @secret, @events, @enabled, @createdAt)`,
  ),
  update: db.prepare(
    `UPDATE alertChannels SET name = @name, kind = @kind, url = @url, secret = @secret,
       events = @events, enabled = @enabled WHERE id = @id`,
  ),
  remove: db.prepare<[string]>('DELETE FROM alertChannels WHERE id = ?'),
  result: db.prepare(
    'UPDATE alertChannels SET lastSentAt = @at, lastStatus = @status, lastError = @error WHERE id = @id',
  ),
  getState: db.prepare<[string], { value: string }>('SELECT value FROM alertState WHERE key = ?'),
  setState: db.prepare('INSERT OR REPLACE INTO alertState (key, value) VALUES (?, ?)'),
};

function safeDecrypt(blob: string | null): string | null {
  if (!blob) return null;
  try {
    return decrypt(blob);
  } catch {
    // Data key rotated or blob damaged: treat as unset rather than crash the
    // whole list. The admin sees an empty URL and can re-enter it.
    return null;
  }
}

function parseEvents(raw: string): AlertEventType[] {
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter((e): e is AlertEventType => (ALERT_EVENTS as readonly string[]).includes(String(e)))
      : [];
  } catch {
    return [];
  }
}

function fromRow(row: ChannelRow): AlertChannel {
  return {
    id: row.id,
    name: row.name,
    kind: (ALERT_CHANNEL_KINDS as readonly string[]).includes(row.kind) ? (row.kind as AlertChannelKind) : 'webhook',
    url: safeDecrypt(row.url) ?? '',
    secret: safeDecrypt(row.secret),
    events: parseEvents(row.events),
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    lastSentAt: row.lastSentAt,
    lastStatus: row.lastStatus === 'ok' || row.lastStatus === 'error' ? row.lastStatus : null,
    lastError: row.lastError,
  };
}

export function listAlertChannels(): AlertChannel[] {
  return stmts.all.all().map(fromRow);
}

export function getAlertChannel(id: string): AlertChannel | null {
  const row = stmts.get.get(id);
  return row ? fromRow(row) : null;
}

export interface AlertChannelInput {
  name: string;
  kind: AlertChannelKind;
  url: string;
  secret?: string | null;
  events: AlertEventType[];
  enabled?: boolean;
}

function toParams(id: string, input: AlertChannelInput) {
  return {
    id,
    name: input.name.trim(),
    kind: input.kind,
    url: encrypt(input.url.trim()),
    secret: input.secret ? encrypt(input.secret) : null,
    events: JSON.stringify([...new Set(input.events)]),
    enabled: input.enabled === false ? 0 : 1,
  };
}

export function createAlertChannel(input: AlertChannelInput): AlertChannel {
  const id = randomUUID();
  stmts.insert.run({ ...toParams(id, input), createdAt: new Date().toISOString() });
  return getAlertChannel(id)!;
}

/**
 * Update a channel. `url` and `secret` left undefined keep their stored
 * value, so the UI never has to send a secret back that it was never shown.
 * `secret: null` clears it.
 */
export function updateAlertChannel(
  id: string,
  patch: Partial<Omit<AlertChannelInput, 'url' | 'secret'>> & { url?: string; secret?: string | null },
): AlertChannel | null {
  const current = getAlertChannel(id);
  if (!current) return null;
  stmts.update.run(toParams(id, {
    name: patch.name ?? current.name,
    kind: patch.kind ?? current.kind,
    url: patch.url ?? current.url,
    secret: patch.secret === undefined ? current.secret : patch.secret,
    events: patch.events ?? current.events,
    enabled: patch.enabled ?? current.enabled,
  }));
  return getAlertChannel(id);
}

export function deleteAlertChannel(id: string): boolean {
  return stmts.remove.run(id).changes > 0;
}

export function recordDeliveryResult(id: string, ok: boolean, error: string | null): void {
  stmts.result.run({ id, at: new Date().toISOString(), status: ok ? 'ok' : 'error', error: ok ? null : error });
}

// ─── Options and bookkeeping ────────────────────────────────────────────────

export function getAlertState<T>(key: string): T | null {
  const row = stmts.getState.get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setAlertState(key: string, value: unknown): void {
  stmts.setState.run(key, JSON.stringify(value));
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Stored options merged over the defaults, each field checked. */
export function getAlertConfig(): AlertConfig {
  const stored = getAlertState<Partial<AlertConfig>>('config') ?? {};
  const cn: Partial<AlertConfig['clearNight']> = stored.clearNight ?? {};
  const d = DEFAULT_ALERT_CONFIG;
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  return {
    language: (ALERT_LANGUAGES as readonly string[]).includes(String(stored.language))
      ? (stored.language as AlertConfig['language'])
      : d.language,
    clearNight: {
      checkTime: typeof cn.checkTime === 'string' && HHMM.test(cn.checkTime) ? cn.checkTime : d.clearNight.checkTime,
      minClearHours: num(cn.minClearHours, 0.5, 14, d.clearNight.minClearHours),
      maxCloudCover: num(cn.maxCloudCover, 0, 100, d.clearNight.maxCloudCover),
    },
  };
}

export function setAlertConfig(patch: { language?: AlertConfig['language']; clearNight?: Partial<AlertConfig['clearNight']> }): AlertConfig {
  const current = getAlertConfig();
  setAlertState('config', {
    language: patch.language ?? current.language,
    clearNight: { ...current.clearNight, ...(patch.clearNight ?? {}) },
  });
  return getAlertConfig();
}
