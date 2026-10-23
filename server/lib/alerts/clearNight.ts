/**
 * "Clear night ahead": once each evening, at a set local time, look at the
 * hourly forecast for the active site and send `night.clear` when enough of
 * the remaining dark hours are under the cloud limit.
 *
 * The evaluation is pure (evaluateClearNight) so it can be tested on a fixed
 * forecast; the scheduler around it only decides when to run it, fetches the
 * forecast and remembers that tonight was checked.
 */
import SunCalc from 'suncalc';
import { getNightWindow } from '../astroCalc.js';
import {
  buildForecast,
  CACHE_TTL_MS,
  getForecastCacheEntry,
  isUsableForecast,
  setForecastCacheEntry,
  type ForecastHour,
} from '../forecastCache.js';
import { getActiveSite } from '../observingSites.js';
import { localDateKey, localParts, zonedDateTimeToUtc } from '../timezone.js';
import { log } from '../logger.js';
import { dispatchAlert } from './delivery.js';
import { getAlertConfig, getAlertState, listAlertChannels, setAlertState } from './store.js';
import type { ClearNightAlertData } from './types.js';

const HOUR_MS = 3_600_000;
/** An hour with a higher chance of rain than this is not clear, whatever the
 *  cloud cover says. */
const MAX_PRECIP_PROB = 40;

export interface ClearNightInput {
  hours: ForecastHour[];
  lat: number;
  lon: number;
  timeZone: string;
  siteName: string;
  /** Observing night, YYYY-MM-DD (the evening's local date). */
  night: string;
  maxCloudCover: number;
  /** Only hours from this moment on count (a check run late in the evening
   *  should not promise hours already gone). */
  from: Date;
}

/** Dark window of a night: astronomical, or nautical where the sky never gets
 *  astronomically dark (high-latitude summer). Null when neither exists. */
export function darkWindow(night: string, lat: number, lon: number, timeZone: string): { start: Date; end: Date } | null {
  const anchor = zonedDateTimeToUtc(night, { hour: 12 }, timeZone);
  const w = getNightWindow(anchor, lat, lon);
  const start = w.astronomicalDusk ?? w.nauticalDusk;
  const end = w.astronomicalDawn ?? w.nauticalDawn;
  if (!start || !end || end <= start) return null;
  return { start, end };
}

function moonAltitude(t: Date, lat: number, lon: number): number {
  return SunCalc.getMoonPosition(t, lat, lon).altitude;
}

/** Moonrise / moonset inside the window, from a 10-minute altitude scan. */
function moonCrossings(start: Date, end: Date, lat: number, lon: number): { rise: string | null; set: string | null } {
  let rise: string | null = null;
  let set: string | null = null;
  let prev = moonAltitude(start, lat, lon);
  for (let t = start.getTime() + 600_000; t <= end.getTime(); t += 600_000) {
    const alt = moonAltitude(new Date(t), lat, lon);
    if (prev < 0 && alt >= 0 && !rise) rise = new Date(t).toISOString();
    if (prev >= 0 && alt < 0 && !set) set = new Date(t).toISOString();
    prev = alt;
  }
  return { rise, set };
}

export function evaluateClearNight(input: ClearNightInput): ClearNightAlertData | null {
  const win = darkWindow(input.night, input.lat, input.lon, input.timeZone);
  if (!win) return null;
  const start = Math.max(win.start.getTime(), input.from.getTime());
  const end = win.end.getTime();
  if (end <= start) return null;

  let clearMs = 0;
  let moonDownMs = 0;
  const seeing: number[] = [];
  let run: { start: number; end: number } | null = null;
  let best: { start: number; end: number } | null = null;
  const closeRun = () => {
    if (run && (!best || run.end - run.start > best.end - best.start)) best = run;
    run = null;
  };

  const hours = [...input.hours].sort((a, b) => a.time.localeCompare(b.time));
  for (const h of hours) {
    const hStart = new Date(h.time).getTime();
    const s = Math.max(hStart, start);
    const e = Math.min(hStart + HOUR_MS, end);
    if (e <= s) continue;
    const clear = h.cloudCover <= input.maxCloudCover && h.precipProb < MAX_PRECIP_PROB;
    if (!clear) {
      closeRun();
      continue;
    }
    clearMs += e - s;
    if (moonAltitude(new Date((s + e) / 2), input.lat, input.lon) < 0) moonDownMs += e - s;
    if (h.seeing !== null) seeing.push(h.seeing);
    if (run && run.end === s) run.end = e;
    else {
      closeRun();
      run = { start: s, end: e };
    }
  }
  closeRun();
  const longest = best as { start: number; end: number } | null;

  const round1 = (ms: number) => Math.round((ms / HOUR_MS) * 10) / 10;
  const mid = new Date((start + end) / 2);
  const crossings = moonCrossings(new Date(start), new Date(end), input.lat, input.lon);
  return {
    siteName: input.siteName,
    night: input.night,
    timeZone: input.timeZone,
    clearHours: round1(clearMs),
    darkHours: round1(end - start),
    longestStart: new Date(longest?.start ?? start).toISOString(),
    longestEnd: new Date(longest?.end ?? start).toISOString(),
    maxCloudCover: input.maxCloudCover,
    seeing: seeing.length > 0 ? Math.round((seeing.reduce((a, b) => a + b, 0) / seeing.length) * 10) / 10 : null,
    moonIllumination: Math.round(SunCalc.getMoonIllumination(mid).fraction * 100),
    moonDownHours: round1(moonDownMs),
    moonRise: crossings.rise,
    moonSet: crossings.set,
  };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

export interface ClearNightCheck {
  night: string;
  checkedAt: string;
  /** Null when there was no forecast or no dark window. */
  result: ClearNightAlertData | null;
  sent: boolean;
  reason: 'sent' | 'not_clear_enough' | 'no_forecast' | 'no_dark_window' | 'no_site' | 'preview';
}

const LAST_CHECK_KEY = 'clearNight.lastCheck';
const RETRY_MS = 15 * 60_000;
let interval: ReturnType<typeof setInterval> | null = null;
let running = false;
let retryAfter = 0;

export function lastClearNightCheck(): ClearNightCheck | null {
  return getAlertState<ClearNightCheck>(LAST_CHECK_KEY);
}

async function forecastHours(lat: number, lon: number): Promise<ForecastHour[] | null> {
  const cached = getForecastCacheEntry(lat, lon);
  const hoursOf = (data: unknown) => (data as { hourly: ForecastHour[] }).hourly;
  if (cached && isUsableForecast(cached.data) && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return hoursOf(cached.data);
  try {
    const data = await buildForecast(lat, lon);
    if (isUsableForecast(data)) {
      setForecastCacheEntry({ data, fetchedAt: Date.now(), lat, lon });
      return hoursOf(data);
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[alerts] forecast unavailable for the clear-night check');
  }
  return cached && isUsableForecast(cached.data) ? hoursOf(cached.data) : null;
}

/**
 * Evaluate tonight for the active site. With `send`, the alert goes out when
 * the night qualifies and tonight is recorded as checked; without it, this is
 * a preview for the settings page.
 */
export async function runClearNightCheck(now: Date, send: boolean): Promise<ClearNightCheck> {
  const site = getActiveSite();
  const tz = site.timezone;
  const night = localDateKey(now, tz);
  const base = { night, checkedAt: now.toISOString(), sent: false };
  if (site.latitude == null || site.longitude == null) return { ...base, result: null, reason: 'no_site' };

  const hours = await forecastHours(site.latitude, site.longitude);
  if (!hours) return { ...base, result: null, reason: 'no_forecast' };

  const config = getAlertConfig();
  const result = evaluateClearNight({
    hours,
    lat: site.latitude,
    lon: site.longitude,
    timeZone: tz,
    siteName: site.name,
    night,
    maxCloudCover: config.clearNight.maxCloudCover,
    from: now,
  });
  if (!result) return { ...base, result: null, reason: 'no_dark_window' };
  if (!send) return { ...base, result, reason: 'preview' };

  const qualifies = result.clearHours >= config.clearNight.minClearHours;
  if (qualifies) await dispatchAlert({ type: 'night.clear', occurredAt: now.toISOString(), data: result });
  return { ...base, result, sent: qualifies, reason: qualifies ? 'sent' : 'not_clear_enough' };
}

/** Due: someone listens, the local clock has passed the check time, and
 *  tonight has not been checked yet. */
export function isClearNightCheckDue(now: Date, checkTime: string, timeZone: string, lastNight: string | null): boolean {
  const [hh, mm] = checkTime.split(':').map(Number);
  const p = localParts(now, timeZone);
  return lastNight !== localDateKey(now, timeZone) && p.hour * 60 + p.minute >= hh * 60 + mm;
}

async function tick(): Promise<void> {
  if (running || Date.now() < retryAfter) return;
  if (!listAlertChannels().some(c => c.enabled && c.events.includes('night.clear'))) return;
  const site = getActiveSite();
  const now = new Date();
  const config = getAlertConfig();
  if (!isClearNightCheckDue(now, config.clearNight.checkTime, site.timezone, lastClearNightCheck()?.night ?? null)) return;

  running = true;
  try {
    const check = await runClearNightCheck(now, true);
    if (check.reason === 'no_forecast') {
      retryAfter = Date.now() + RETRY_MS; // try again later this evening
      return;
    }
    setAlertState(LAST_CHECK_KEY, check);
  } catch (err) {
    retryAfter = Date.now() + RETRY_MS;
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[alerts] clear-night check failed');
  } finally {
    running = false;
  }
}

export function startClearNightScheduler(): void {
  stopClearNightScheduler();
  interval = setInterval(() => { void tick(); }, 60_000);
}

export function stopClearNightScheduler(): void {
  if (interval) clearInterval(interval);
  interval = null;
}

export const _clearNightTickForTests = tick;
