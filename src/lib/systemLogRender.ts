/**
 * Renders a System Log entry's display sentence from `event` + `metadata`
 * instead of trusting the stored `message` column.
 *
 * Why this exists: `message` is written once, in English, at insert time,
 * and a row can never be edited after the fact — so if the UI just prints
 * `entry.message`, a German-speaking admin is stuck reading English forever.
 * `event` and `metadata` are structured and already present on every row
 * (see server/lib/systemLog.ts), so rendering from them keeps the sentence
 * swappable at display time via `t('systemLog.<event>', params)`.
 *
 * `entry.message` is kept as the fallback for any event this registry does
 * not recognize — an event added later without a matching entry here, or a
 * row written by an older build with metadata this version doesn't expect.
 * Rows written before this change also fall through to it, since their
 * metadata may be missing fields a template below expects.
 */
import type { SystemLogEntry } from './api/systemLog';

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

type Meta = Record<string, unknown>;

function str(meta: Meta | null, key: string): string | null {
  const v = meta?.[key];
  return typeof v === 'string' ? v : null;
}

function num(meta: Meta | null, key: string): number | null {
  const v = meta?.[key];
  return typeof v === 'number' ? v : null;
}

function bool(meta: Meta | null, key: string): boolean | null {
  const v = meta?.[key];
  return typeof v === 'boolean' ? v : null;
}

function list(meta: Meta | null, key: string): string[] | null {
  const v = meta?.[key];
  return Array.isArray(v) && v.every(x => typeof x === 'string') ? v : null;
}

type Renderer = (entry: SystemLogEntry, t: TFunc) => string | null;

const renderers: Record<string, Renderer> = {
  db_backup_created: (e, t) => {
    const m = e.metadata;
    const from = str(m, 'previousVersion') ?? t('systemLog.anEarlierVersion');
    const to = str(m, 'currentVersion');
    const name = str(m, 'backupName');
    if (!to || !name) return null;
    return t('systemLog.dbBackupCreated', { from, to, name });
  },
  db_backup_failed: (e, t) => {
    const m = e.metadata;
    const to = str(m, 'currentVersion');
    const error = str(m, 'error');
    if (!to || !error) return null;
    return t('systemLog.dbBackupFailed', { to, error });
  },
  db_backup_manual: (e, t) => {
    const name = str(e.metadata, 'backupName');
    return name ? t('systemLog.dbBackupManual', { name }) : null;
  },
  db_backup_deleted: (e, t) => {
    const name = str(e.metadata, 'backupName');
    return name ? t('systemLog.dbBackupDeleted', { name }) : null;
  },
  update_check_failed: (e, t) => {
    const channel = str(e.metadata, 'channel');
    return channel ? t('systemLog.updateCheckFailed', { channel }) : null;
  },
  update_available: (e, t) => {
    const m = e.metadata;
    const from = str(m, 'fromVersion');
    const to = str(m, 'toVersion');
    const channel = str(m, 'channel');
    if (!from || !to || !channel) return null;
    return t('systemLog.updateAvailable', { from, to, channel });
  },
  update_verify_failed: (e, t) => {
    const version = str(e.metadata, 'version');
    return version ? t('systemLog.updateVerifyFailed', { version }) : null;
  },
  update_staged: (e, t) => {
    const version = str(e.metadata, 'version');
    return version ? t('systemLog.updateStaged', { version }) : null;
  },
  update_applied: (e, t) => {
    const version = str(e.metadata, 'version');
    return version ? t('systemLog.updateApplied', { version }) : null;
  },
  paired: (e, t) => {
    const name = str(e.metadata, 'deviceName');
    return name && e.username ? t('systemLog.paired', { name, username: e.username }) : null;
  },
  revoked: (e, t) => {
    // Shared by three call sites (self-revoke, admin revoke, bulk revoke on
    // reauth) with different metadata shapes; try the most specific first.
    const m = e.metadata;
    const count = num(m, 'count');
    if (count !== null) {
      const reason = str(m, 'reason');
      return reason
        ? t('systemLog.revokedCountWithReason', { count, reason })
        : t('systemLog.revokedCount', { count });
    }
    const name = str(m, 'deviceName');
    if (!name) return null;
    return e.level === 'warning' && str(m, 'ownerUserId')
      ? t('systemLog.revokedDeviceAdmin', { name })
      : t('systemLog.revokedDevice', { name });
  },
  folder_import_finished: (e, t) => renderSyncEvent(e, t),
  sync_finished: (e, t) => renderSyncEvent(e, t),
  rate_limited: (e, t) => {
    const failures = num(e.metadata, 'failures');
    return failures !== null && e.ip ? t('systemLog.rateLimited', { ip: e.ip, count: failures }) : null;
  },
  first_user_registered: (e, t) => e.username ? t('systemLog.firstUserRegistered', { username: e.username }) : null,
  login_success: (e, t) => e.username ? t('systemLog.loginSuccess', { username: e.username }) : null,
  login_failed: (e, t) => e.username ? t('systemLog.loginFailed', { username: e.username }) : null,
  created: (e, t) => {
    // 'user' category only; 'telescope' category has its own 'added' event.
    if (e.category !== 'user') return null;
    const name = str(e.metadata, 'targetUsername');
    const role = str(e.metadata, 'role');
    return name && role ? t('systemLog.userCreated', { name, role }) : null;
  },
  deleted: (e, t) => {
    const name = str(e.metadata, 'targetUsername');
    return name ? t('systemLog.userDeleted', { name }) : null;
  },
  password_reset: (e, t) => {
    const name = str(e.metadata, 'targetUsername') ?? str(e.metadata, 'targetUserId');
    return name ? t('systemLog.passwordReset', { name }) : null;
  },
  role_changed: (e, t) => {
    const m = e.metadata;
    const name = str(m, 'targetUsername') ?? str(m, 'targetUserId');
    const oldRole = str(m, 'oldRole') ?? t('systemLog.unknownRole');
    const newRole = str(m, 'newRole');
    return name && newRole ? t('systemLog.roleChanged', { name, oldRole, newRole }) : null;
  },
  updated: (e, t) => {
    const fields = list(e.metadata, 'changedFields');
    return fields ? t('systemLog.settingsUpdated', { fields: fields.join(', ') }) : null;
  },
  api_key_generated: (_e, t) => t('systemLog.apiKeyGenerated'),
  api_key_revoked: (_e, t) => t('systemLog.apiKeyRevoked'),
  database_reset: (_e, t) => t('systemLog.databaseReset'),
  library_location_reset: (e, t) => {
    const prev = str(e.metadata, 'previousPath');
    return prev ? t('systemLog.libraryLocationReset', { previousPath: prev }) : null;
  },
  library_migration_started: (e, t) => {
    const m = e.metadata;
    if (str(m, 'target') === 'network') {
      const host = str(m, 'host');
      const share = str(m, 'share');
      return host && share ? t('systemLog.libraryMigrationStartedNetwork', { host, share }) : null;
    }
    const targetPath = str(m, 'targetPath');
    return targetPath ? t('systemLog.libraryMigrationStarted', { targetPath }) : null;
  },
  log_cleared: (_e, t) => t('systemLog.logCleared'),
  added: (e, t) => {
    if (e.category !== 'telescope') return null;
    const name = str(e.metadata, 'name');
    return name ? t('systemLog.telescopeAdded', { name }) : null;
  },
  removed: (e, t) => {
    const name = str(e.metadata, 'name') ?? str(e.metadata, 'telescopeId');
    return name ? t('systemLog.telescopeRemoved', { name }) : null;
  },
  archived: (e, t) => {
    const name = str(e.metadata, 'name') ?? str(e.metadata, 'telescopeId');
    return name ? t('systemLog.telescopeArchived', { name }) : null;
  },
  unarchived: (e, t) => {
    const name = str(e.metadata, 'name') ?? str(e.metadata, 'telescopeId');
    return name ? t('systemLog.telescopeUnarchived', { name }) : null;
  },
};

function renderSyncEvent(e: SystemLogEntry, t: TFunc): string | null {
  const m = e.metadata;
  const source = str(m, 'source');
  const telescopeName = str(m, 'telescopeName');
  const cancelled = bool(m, 'cancelled');
  const error = str(m, 'error');
  const newFiles = num(m, 'newFiles');
  const manual = bool(m, 'manual');
  if (cancelled === null || manual === null) return null;

  const originLabel = source === 'folder'
    ? t('systemLog.originFolder')
    : source === 'subframe'
      ? t('systemLog.originSubframe', { name: telescopeName ?? t('systemLog.aTelescope') })
      : (telescopeName ?? t('systemLog.aTelescope'));
  const trigger = manual ? t('systemLog.triggerManual') : t('systemLog.triggerScheduled');

  if (cancelled) return t('systemLog.syncCancelled', { trigger, origin: originLabel });
  if (error) return t('systemLog.syncFailed', { trigger, origin: originLabel, error });
  if (newFiles === null) return null;
  return t('systemLog.syncCompleted', { trigger, origin: originLabel, count: newFiles });
}

/**
 * The display sentence for a System Log row. Prefers reconstructing from
 * `event` + `metadata`; falls back to the stored `message` when the event is
 * unrecognized or the metadata this build expects is missing (older rows,
 * or an event this registry hasn't been updated for).
 */
export function renderLogEntry(entry: SystemLogEntry, t: TFunc): string {
  const renderer = renderers[entry.event];
  const rendered = renderer?.(entry, t);
  return rendered ?? entry.message;
}
