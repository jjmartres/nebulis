import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-alertclearnight-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import {
  darkWindow,
  evaluateClearNight,
  isClearNightCheckDue,
  lastClearNightCheck,
  runClearNightCheck,
  _clearNightTickForTests,
} from '../../server/lib/alerts/clearNight';
import { createAlertChannel, setAlertConfig } from '../../server/lib/alerts/store';
import { _clearForecastCache, setForecastCacheEntry, type ForecastHour } from '../../server/lib/forecastCache';
import { createSite, setActiveSite } from '../../server/lib/observingSites';

const LAT = 45.66;
const LON = 6.3;
const TZ = 'Europe/Paris';
const NIGHT = '2026-10-15';

/** Hourly forecast from noon UTC on the 15th to noon on the 16th. */
function hours(cloudAt: (iso: string) => number = () => 5, over: Partial<ForecastHour> = {}): ForecastHour[] {
  const out: ForecastHour[] = [];
  for (let t = Date.parse('2026-10-15T12:00:00Z'); t < Date.parse('2026-10-16T12:00:00Z'); t += 3_600_000) {
    const time = new Date(t).toISOString();
    out.push({
      time, cloudCover: cloudAt(time), cloudCoverLow: 0, cloudCoverMid: 0, cloudCoverHigh: 0, seeing: 2, transparency: 3,
      humidity: 60, temperature: 5, dewPoint: 0, wind: 5, visibility: null, precipProb: 0, jetStream: null, cape: null, ...over,
    });
  }
  return out;
}

const input = (h: ForecastHour[], from = new Date('2026-10-15T15:00:00Z')) => ({
  hours: h, lat: LAT, lon: LON, timeZone: TZ, siteName: 'Verrens-Arvey', night: NIGHT, maxCloudCover: 30, from,
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('evaluateClearNight', () => {
  const win = darkWindow(NIGHT, LAT, LON, TZ)!;
  const darkHours = Math.round(((win.end.getTime() - win.start.getTime()) / 3_600_000) * 10) / 10;

  it('counts the whole astronomical night when every hour is clear', () => {
    expect(win.start.toISOString().slice(0, 13)).toBe('2026-10-15T18');
    const r = evaluateClearNight(input(hours()))!;
    expect(r.clearHours).toBe(darkHours);
    expect(r.darkHours).toBe(darkHours);
    expect(r.longestStart).toBe(win.start.toISOString());
    expect(r.longestEnd).toBe(win.end.toISOString());
    expect(r.seeing).toBe(2);
    expect(r.moonIllumination).toBeLessThan(30); // a few days after new Moon
  });

  it('finds the longest clear stretch around a cloudy spell, and ignores rainy hours', () => {
    const cloudy = (iso: string) => (iso >= '2026-10-15T22' && iso < '2026-10-16T01' ? 90 : 5);
    const r = evaluateClearNight(input(hours(cloudy)))!;
    expect(r.clearHours).toBeCloseTo(darkHours - 3, 1);
    // Before the clouds (~18:40–22:00 UTC) is shorter than after (01:00–dawn ~04:20)? Pick whichever is longer.
    const before = Date.parse('2026-10-15T22:00:00Z') - win.start.getTime();
    const after = win.end.getTime() - Date.parse('2026-10-16T01:00:00Z');
    expect(r.longestStart).toBe(before >= after ? win.start.toISOString() : '2026-10-16T01:00:00.000Z');

    const rainy = evaluateClearNight(input(hours(() => 5, { precipProb: 60 })))!;
    expect(rainy.clearHours).toBe(0);
  });

  it('only counts the hours still ahead', () => {
    const r = evaluateClearNight(input(hours(), new Date('2026-10-16T00:00:00Z')))!;
    expect(r.longestStart).toBe('2026-10-16T00:00:00.000Z');
    expect(r.clearHours).toBe(Math.round(((win.end.getTime() - Date.parse('2026-10-16T00:00:00Z')) / 3_600_000) * 10) / 10);
  });

  it('has no dark window where the sky never gets dark', () => {
    expect(darkWindow('2026-06-21', 78, 15, 'Europe/Oslo')).toBeNull();
  });
});

describe('isClearNightCheckDue', () => {
  it('runs once the local check time has passed, once per night', () => {
    const at = (iso: string) => new Date(iso);
    expect(isClearNightCheckDue(at('2026-10-15T14:59:00Z'), '17:00', TZ, null)).toBe(false); // 16:59 Paris
    expect(isClearNightCheckDue(at('2026-10-15T15:00:00Z'), '17:00', TZ, null)).toBe(true);
    expect(isClearNightCheckDue(at('2026-10-15T15:00:00Z'), '17:00', TZ, '2026-10-15')).toBe(false);
    expect(isClearNightCheckDue(at('2026-10-15T15:00:00Z'), '17:00', TZ, '2026-10-14')).toBe(true);
  });
});

describe('the evening check', () => {
  let receiver: http.Server;
  let base: string;
  const received: string[] = [];

  beforeAll(async () => {
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { received.push(body); res.end(); });
    });
    await new Promise<void>(resolve => receiver.listen(0, resolve));
    base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    const site = createSite({ name: 'Verrens-Arvey', latitude: LAT, longitude: LON, timezone: TZ });
    setActiveSite(site.id);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => receiver.close(() => resolve()));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const seed = (cloudAt?: (iso: string) => number) => {
    _clearForecastCache();
    setForecastCacheEntry({
      data: { hourly: hours(cloudAt), sources: { weather: 'open-meteo', seeing: '7timer' } },
      fetchedAt: Date.now(), lat: LAT, lon: LON,
    });
  };

  it('previews without sending', async () => {
    seed();
    const check = await runClearNightCheck(new Date('2026-10-15T15:00:00Z'), false);
    expect(check).toMatchObject({ night: NIGHT, reason: 'preview', sent: false, result: { siteName: 'Verrens-Arvey' } });
  });

  it('holds back a night under the minimum', async () => {
    seed(iso => (iso >= '2026-10-15T20' ? 90 : 5)); // clouds from 22:00 local
    setAlertConfig({ clearNight: { minClearHours: 3 } });
    const check = await runClearNightCheck(new Date('2026-10-15T15:00:00Z'), true);
    expect(check).toMatchObject({ reason: 'not_clear_enough', sent: false });
  });

  it('sends once at the check time, then not again that night', async () => {
    seed();
    setAlertConfig({ language: 'fr', clearNight: { checkTime: '17:00', minClearHours: 3 } });
    createAlertChannel({ name: 'hook', kind: 'webhook', url: `${base}/h`, events: ['night.clear'] });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T15:05:00Z'));
    seed(); // fetchedAt under the fake clock, so the cache counts as fresh
    await _clearNightTickForTests();
    await _clearNightTickForTests();
    expect(received).toHaveLength(1);
    const body = JSON.parse(received[0]!);
    expect(body).toMatchObject({ event: 'night.clear', title: 'Nuit dégagée prévue à Verrens-Arvey', data: { night: NIGHT } });
    expect(lastClearNightCheck()).toMatchObject({ night: NIGHT, sent: true, reason: 'sent' });
  });
});
