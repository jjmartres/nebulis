import { fetchJSON } from './client';

/**
 * Alerts — where Nebulis sends what it notices on its own (an import finished,
 * a clear night ahead…). Mirrors server/routes/alerts.ts. Admin only.
 *
 * Channel URLs and secrets are write-only: the server returns a masked
 * `urlPreview` and `hasSecret`, and an update that leaves `url` / `secret`
 * out keeps the stored value.
 */
export const ALERT_CHANNEL_KINDS = ['ntfy', 'discord', 'slack', 'webhook'] as const;
export type AlertChannelKind = (typeof ALERT_CHANNEL_KINDS)[number];

export const ALERT_EVENTS = ['night.clear', 'import.finished', 'import.failed', 'update.available'] as const;
export type AlertEventType = (typeof ALERT_EVENTS)[number];

export const ALERT_LANGUAGES = ['en', 'fr', 'de', 'es', 'nl'] as const;
export type AlertLanguage = (typeof ALERT_LANGUAGES)[number];

export interface AlertChannel {
  id: string;
  name: string;
  kind: AlertChannelKind;
  urlPreview: string;
  hasSecret: boolean;
  events: AlertEventType[];
  enabled: boolean;
  createdAt: string;
  lastSentAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
}

export interface AlertConfig {
  language: AlertLanguage;
  clearNight: { checkTime: string; minClearHours: number; maxCloudCover: number };
}

export interface ClearNightResult {
  siteName: string;
  night: string;
  timeZone: string;
  clearHours: number;
  darkHours: number;
  longestStart: string;
  longestEnd: string;
  maxCloudCover: number;
  seeing: number | null;
  moonIllumination: number;
  moonDownHours: number;
}

export interface ClearNightCheck {
  night: string;
  checkedAt: string;
  result: ClearNightResult | null;
  sent: boolean;
  reason: 'sent' | 'not_clear_enough' | 'no_forecast' | 'no_dark_window' | 'no_site' | 'preview';
}

export interface AlertsOverview {
  channels: AlertChannel[];
  config: AlertConfig;
  lastClearNightCheck: ClearNightCheck | null;
}

export interface AlertChannelInput {
  name: string;
  kind: AlertChannelKind;
  url: string;
  secret?: string | null;
  events: AlertEventType[];
  enabled?: boolean;
}

export interface AlertTestResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  channel: AlertChannel;
}

export const getAlerts = () => fetchJSON<AlertsOverview>('/alerts');

export const createAlertChannel = (input: AlertChannelInput) =>
  fetchJSON<AlertChannel>('/alerts/channels', { method: 'POST', body: JSON.stringify(input) });

export const updateAlertChannel = (id: string, patch: Partial<AlertChannelInput>) =>
  fetchJSON<AlertChannel>(`/alerts/channels/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });

export const deleteAlertChannel = (id: string) =>
  fetchJSON<{ deleted: boolean }>(`/alerts/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const testAlertChannel = (id: string) =>
  fetchJSON<AlertTestResult>(`/alerts/channels/${encodeURIComponent(id)}/test`, { method: 'POST' });

export const updateAlertConfig = (patch: { language?: AlertLanguage; clearNight?: Partial<AlertConfig['clearNight']> }) =>
  fetchJSON<AlertConfig>('/alerts/config', { method: 'PUT', body: JSON.stringify(patch) });

export const previewClearNight = () =>
  fetchJSON<ClearNightCheck>('/alerts/clear-night/preview', { method: 'POST' });
