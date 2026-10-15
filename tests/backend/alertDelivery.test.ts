import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createHmac } from 'crypto';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-alertdelivery-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import {
  buildAlertRequest,
  dispatchAlert,
  sendToChannel,
  _setRetryDelayForTests,
} from '../../server/lib/alerts/delivery';
import { formatAlert, formatHours, _alertStringsForTests } from '../../server/lib/alerts/messages';
import { createAlertChannel, deleteAlertChannel, getAlertChannel, listAlertChannels, setAlertConfig } from '../../server/lib/alerts/store';
import { announceUpdate } from '../../server/lib/alerts/index';
import { writeImportHistory } from '../../server/lib/library/importHistory';
import type { AlertChannel, AlertEvent, ClearNightAlertData, ImportAlertData } from '../../server/lib/alerts/types';
import type { ImportStatus } from '../../server/lib/library/importTypes';

let receiver: http.Server;
let base: string;
let received: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let replies: number[] = [];

beforeAll(async () => {
  _setRetryDelayForTests(10);
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      res.statusCode = replies.shift() ?? 200;
      res.end();
    });
  });
  await new Promise<void>(resolve => receiver.listen(0, resolve));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => receiver.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  received = [];
  replies = [];
  for (const c of listAlertChannels()) deleteAlertChannel(c.id);
  setAlertConfig({ language: 'en' });
});

const channel = (over: Partial<AlertChannel>): AlertChannel => ({
  id: 'c1', name: 'c', kind: 'webhook', url: 'https://example.test/hook', secret: null, events: [], enabled: true,
  createdAt: '', lastSentAt: null, lastStatus: null, lastError: null, ...over,
});

const importData: ImportAlertData = {
  source: 'telescope', telescopeName: 'Elendil', newFiles: 42, manual: false, error: null,
  objects: [{ objectId: 'NGC6888', name: 'NGC6888', isNew: false }, { objectId: 'M27', name: 'M27', isNew: true }],
  sessions: [{ objectId: 'NGC6888', objectName: 'NGC6888', date: '2026-10-14' }],
};
const importEvent: AlertEvent = { type: 'import.finished', occurredAt: '2026-10-15T06:00:00.000Z', data: importData };

const clearData: ClearNightAlertData = {
  siteName: 'Verrens-Arvey', night: '2026-10-15', timeZone: 'Europe/Paris', clearHours: 5.5, darkHours: 9.5,
  longestStart: '2026-10-15T20:00:00.000Z', longestEnd: '2026-10-16T01:30:00.000Z', maxCloudCover: 30, seeing: 1.8,
  moonIllumination: 12, moonDownHours: 4.5, moonRise: null, moonSet: '2026-10-15T21:00:00.000Z',
};

describe('alert messages', () => {
  it('has the same keys in every language', () => {
    const keys = Object.keys(_alertStringsForTests.en).sort();
    for (const table of Object.values(_alertStringsForTests)) expect(Object.keys(table).sort()).toEqual(keys);
  });

  it('describes an import', () => {
    expect(formatAlert(importEvent, 'en')).toMatchObject({ title: 'Import finished', body: '42 new files from Elendil: NGC6888, M27' });
    expect(formatAlert(importEvent, 'fr').body).toBe('42 nouveaux fichiers depuis Elendil : NGC6888, M27');
    const failed = formatAlert({ ...importEvent, type: 'import.failed', data: { ...importData, source: 'folder', error: 'disk full' } }, 'en');
    expect(failed).toMatchObject({ title: 'Import failed', body: 'a local folder: disk full' });
  });

  it('lists five objects and counts the rest', () => {
    const objects = Array.from({ length: 7 }, (_, i) => ({ objectId: `M${i}`, name: `M${i}`, isNew: false }));
    expect(formatAlert({ ...importEvent, data: { ...importData, objects } }, 'en').body).toBe('42 new files from Elendil: M0, M1, M2, M3, M4 +2 more');
  });

  it('describes a clear night in local time', () => {
    const en = formatAlert({ type: 'night.clear', occurredAt: '', data: clearData }, 'en');
    expect(en.title).toBe('Clear night ahead at Verrens-Arvey');
    expect(en.body).toBe([
      '5.5 h clear out of 9.5 h of darkness (clouds up to 30%), best from 22:00 to 03:30',
      'Moon 12%, below the horizon for 4.5 h of the clear hours',
      'Seeing: good',
    ].join('\n'));
    expect(formatAlert({ type: 'night.clear', occurredAt: '', data: clearData }, 'fr').body.split('\n')[0])
      .toBe('5,5 h dégagées sur 9,5 h de nuit noire (nuages jusqu’à 30 %), meilleur créneau de 22:00 à 03:30');
    const moonUp = formatAlert({ type: 'night.clear', occurredAt: '', data: { ...clearData, moonDownHours: 0, seeing: null } }, 'en');
    expect(moonUp.body.split('\n')).toEqual([expect.any(String), 'Moon 12%, up for all the clear hours']);
  });

  it('rounds hours to the half hour', () => {
    expect(formatHours(3, 'en')).toBe('3 h');
    expect(formatHours(4.26, 'en')).toBe('4.5 h');
    expect(formatHours(4.24, 'de')).toBe('4 h');
  });
});

describe('request shapes', () => {
  const message = formatAlert(importEvent, 'en');

  it('posts signed JSON to a generic webhook', () => {
    const req = buildAlertRequest(channel({ secret: 'k' }), importEvent, message);
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ source: 'nebulis', event: 'import.finished', title: 'Import finished', occurredAt: importEvent.occurredAt, data: importData });
    expect(req.headers['X-Nebulis-Event']).toBe('import.finished');
    expect(req.headers['X-Nebulis-Signature']).toBe(`sha256=${createHmac('sha256', 'k').update(req.body).digest('hex')}`);
    expect(buildAlertRequest(channel({}), importEvent, message).headers['X-Nebulis-Signature']).toBeUndefined();
  });

  it('puts the ntfy title in the query, keeping any token already there', () => {
    const req = buildAlertRequest(channel({ kind: 'ntfy', url: 'https://ntfy.sh/astro?auth=tok' }), importEvent, formatAlert(importEvent, 'fr'));
    const url = new URL(req.url);
    expect(url.searchParams.get('auth')).toBe('tok');
    expect(url.searchParams.get('title')).toBe('Import terminé');
    expect(url.searchParams.get('tags')).toBe('inbox_tray');
    expect(req.body).toBe('42 nouveaux fichiers depuis Elendil : NGC6888, M27');
  });

  it('uses the Discord and Slack message fields', () => {
    expect(JSON.parse(buildAlertRequest(channel({ kind: 'discord' }), importEvent, message).body))
      .toEqual({ content: '**Import finished**\n42 new files from Elendil: NGC6888, M27', username: 'Nebulis' });
    expect(JSON.parse(buildAlertRequest(channel({ kind: 'slack' }), importEvent, message).body))
      .toEqual({ text: '*Import finished*\n42 new files from Elendil: NGC6888, M27' });
  });
});

describe('sending', () => {
  it('retries once on a server error, not on a client error', async () => {
    const c = createAlertChannel({ name: 'hook', kind: 'webhook', url: `${base}/h`, events: ['import.finished'] });
    replies = [503, 200];
    expect(await sendToChannel(c, importEvent)).toMatchObject({ ok: true, status: 200 });
    expect(received).toHaveLength(2);

    received = [];
    replies = [404];
    expect(await sendToChannel(c, importEvent)).toMatchObject({ ok: false, status: 404 });
    expect(received).toHaveLength(1);
    expect(getAlertChannel(c.id)).toMatchObject({ lastStatus: 'error', lastError: 'HTTP 404' });
  });

  it('dispatches only to enabled channels subscribed to the event', async () => {
    createAlertChannel({ name: 'yes', kind: 'slack', url: `${base}/yes`, events: ['import.finished'] });
    createAlertChannel({ name: 'other event', kind: 'slack', url: `${base}/other`, events: ['night.clear'] });
    createAlertChannel({ name: 'off', kind: 'slack', url: `${base}/off`, events: ['import.finished'], enabled: false });
    await dispatchAlert(importEvent);
    expect(received.map(r => r.url)).toEqual(['/yes']);
  });

  it('alerts on an import that brought files or failed, not on an empty or cancelled one', async () => {
    createAlertChannel({ name: 'all', kind: 'webhook', url: `${base}/all`, events: ['import.finished', 'import.failed'] });
    const status = (over: Partial<ImportStatus>) => ({
      startedAt: new Date().toISOString(), objectsTotal: 1, filesTotal: 1, bytesTotal: 0, error: null,
      telescopeId: 't', telescopeName: 'Elendil', transportKind: null, skipped: [], manual: false, cancelled: false, ...over,
    }) as unknown as ImportStatus;
    const acc = (files: number) => ({
      newFiles: Array.from({ length: files }, (_, i) => ({ name: `f${i}.fits`, size: 1 })),
      bytesNew: 0,
      objectsTouched: new Map([['M27', { objectId: 'M27', name: 'M27', isNew: false }]]),
      sessionsTouched: new Map(),
      source: 'telescope' as const,
    });
    const settle = () => new Promise(r => setTimeout(r, 200));

    writeImportHistory(status({}), acc(0));
    writeImportHistory(status({ cancelled: true, error: 'cancelled' }), acc(3));
    await settle();
    expect(received).toHaveLength(0);

    writeImportHistory(status({}), acc(3));
    writeImportHistory(status({ error: 'Wi-Fi lost' }), acc(0));
    await settle();
    const events = received.map(r => JSON.parse(r.body)).sort((a, b) => a.event.localeCompare(b.event));
    expect(events.map(e => e.event)).toEqual(['import.failed', 'import.finished']);
    expect(events[1].data).toMatchObject({ newFiles: 3, telescopeName: 'Elendil', objects: [{ objectId: 'M27' }] });
    expect(events[0].message).toBe('Elendil: Wi-Fi lost');
  });

  it('announces each new version once', async () => {
    createAlertChannel({ name: 'u', kind: 'webhook', url: `${base}/u`, events: ['update.available'] });
    const status = { currentVersion: '2.1.2', latestVersion: '2.2.0', notesUrl: 'https://example.test/notes', updateAvailable: true } as never;
    announceUpdate(status);
    announceUpdate(status);
    await new Promise(r => setTimeout(r, 200));
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.body)).toMatchObject({ title: 'Nebulis 2.2.0 is available', url: 'https://example.test/notes' });
  });
});
