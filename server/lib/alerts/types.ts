/**
 * Alerts: shapes shared by the store, the delivery and the routes.
 *
 * An alert is an event Nebulis noticed on its own (an import finished, a clear
 * night is coming) sent to one or more channels the admin set up: a generic
 * JSON webhook, an ntfy topic, a Discord or a Slack incoming webhook.
 */

export const ALERT_CHANNEL_KINDS = ['webhook', 'ntfy', 'discord', 'slack'] as const;
export type AlertChannelKind = (typeof ALERT_CHANNEL_KINDS)[number];

/** Events a channel can subscribe to. `test` is not subscribable: it goes to
 *  the one channel being tested. */
export const ALERT_EVENTS = ['import.finished', 'import.failed', 'night.clear', 'update.available'] as const;
export type AlertEventType = (typeof ALERT_EVENTS)[number];

export const ALERT_LANGUAGES = ['en', 'fr', 'de', 'es', 'nl'] as const;
export type AlertLanguage = (typeof ALERT_LANGUAGES)[number];

export interface AlertChannel {
  id: string;
  name: string;
  kind: AlertChannelKind;
  url: string;
  /** HMAC-SHA256 signing secret for the generic webhook; null when unset. */
  secret: string | null;
  events: AlertEventType[];
  enabled: boolean;
  createdAt: string;
  lastSentAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
}

/** Event data, by type. Times are ISO strings. */
export interface ImportAlertData {
  source: 'telescope' | 'folder' | 'subframe';
  telescopeName: string | null;
  newFiles: number;
  objects: { objectId: string; name: string; isNew: boolean }[];
  sessions: { objectId: string; objectName: string; date: string }[];
  manual: boolean;
  error: string | null;
}

export interface ClearNightAlertData {
  siteName: string;
  /** Observing night, YYYY-MM-DD (the evening's date). */
  night: string;
  timeZone: string;
  /** Hours of dark sky under the cloud limit. */
  clearHours: number;
  darkHours: number;
  /** Longest clear stretch. */
  longestStart: string;
  longestEnd: string;
  maxCloudCover: number;
  /** Mean 7Timer seeing (1 best – 5) over the clear hours, when known. */
  seeing: number | null;
  moonIllumination: number;
  /** Clear hours with the Moon below the horizon. */
  moonDownHours: number;
  moonRise: string | null;
  moonSet: string | null;
}

export interface UpdateAlertData {
  currentVersion: string;
  latestVersion: string;
  notesUrl: string | null;
}

export type AlertEvent =
  | { type: 'import.finished' | 'import.failed'; occurredAt: string; data: ImportAlertData }
  | { type: 'night.clear'; occurredAt: string; data: ClearNightAlertData }
  | { type: 'update.available'; occurredAt: string; data: UpdateAlertData }
  | { type: 'test'; occurredAt: string; data: Record<string, never> };

export interface AlertConfig {
  language: AlertLanguage;
  clearNight: {
    /** Local time (HH:MM, active site's timezone) the evening check runs. */
    checkTime: string;
    /** Minimum clear dark hours for the alert to go out. */
    minClearHours: number;
    /** Cloud cover (%) at or below which an hour counts as clear. */
    maxCloudCover: number;
  };
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  language: 'en',
  clearNight: { checkTime: '17:00', minClearHours: 3, maxCloudCover: 30 },
};
