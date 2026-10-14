import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-subquality-routes-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { stmts } from '../../server/lib/library/objects';
import { recordLibraryFile } from '../../server/lib/library/libraryFiles';
import { waitForQualityJob } from '../../server/lib/library/subFrameQuality';
import { updateSettingsData } from '../../server/lib/telescopes';

const W = 320;
const H = 240;
const NIGHT = '2026-09-05';

/** 16-bit FITS with a grid of Gaussian stars; `sigma` sets the focus. */
function fitsWithStars(sigma: number, nStars: number, filter = 'H'): Buffer {
  const card = (k: string, v: string) => `${k.padEnd(8)}= ${v.padStart(20)}`.padEnd(80);
  let header = [
    card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'),
    card('NAXIS1', String(W)), card('NAXIS2', String(H)), card('BZERO', '32768'),
    card('EXPTIME', '180'), `${'FILTER'.padEnd(8)}= '${filter}'`.padEnd(80), 'END'.padEnd(80),
  ].join('');
  header = header.padEnd(Math.ceil(header.length / 2880) * 2880);
  const px = new Float64Array(W * H).fill(1000);
  let seed = 7;
  for (let i = 0; i < px.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; px[i] += (seed % 21) - 10; }
  const cols = Math.ceil(Math.sqrt(nStars));
  for (let k = 0; k < nStars; k++) {
    const cx = 25 + (k % cols) * ((W - 50) / cols);
    const cy = 25 + Math.floor(k / cols) * ((H - 50) / cols);
    for (let y = Math.floor(cy - 10); y < cy + 10; y++) {
      for (let x = Math.floor(cx - 10); x < cx + 10; x++) {
        px[y * W + x] += 4000 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma ** 2));
      }
    }
  }
  const data = Buffer.alloc(W * H * 2);
  for (let i = 0; i < px.length; i++) data.writeInt16BE(Math.round(px[i]) - 32768, i * 2);
  const pad = (2880 - (data.length % 2880)) % 2880;
  return Buffer.concat([Buffer.from(header, 'ascii'), data, Buffer.alloc(pad)]);
}

function addSub(name: string, buf: Buffer) {
  fs.mkdirSync(path.join(LIBRARY_DIR, 'NGC6888'), { recursive: true });
  fs.writeFileSync(path.join(LIBRARY_DIR, 'NGC6888', name), buf);
  recordLibraryFile({ objectId: 'NGC6888', folderName: 'NGC6888', fileName: name, role: 'sub', captureDate: NIGHT, captureTime: '223000' });
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  updateSettingsData({ groupObservingNights: true });
  stmts.upsertObject.run('NGC6888', 'NGC6888', 0, new Date().toISOString(), 0, null, 'NGC6888', 'Crescent', null, null, null, null, null, null, null);
  for (let i = 0; i < 5; i++) addSub(`good_${i}.fits`, fitsWithStars(1.5, 30));
  addSub('soft.fits', fitsWithStars(2.6, 30));
  addSub('clouds.fits', fitsWithStars(1.5, 8));
  addSub('broken.fits', Buffer.from('SIMPLE  =                    T'.padEnd(2880)));

  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => { req.id = 't'; req.userId = 'u'; req.userRole = 'admin'; next(); });
  app.use('/', libraryRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const base = () => `${baseUrl}/objects/NGC6888/sessions/${NIGHT}/quality`;

describe('sub-frame quality routes', () => {
  it('lists the night\'s subs unmeasured, then measures them in a background job', async () => {
    let report = (await (await fetch(base())).json()).data;
    expect(report.total).toBe(8);
    expect(report.measured).toBe(0);

    const start = await fetch(`${base()}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect((await start.json()).data).toMatchObject({ total: 8, running: true });
    await waitForQualityJob('NGC6888', NIGHT);

    report = (await (await fetch(base())).json()).data;
    expect(report.measured).toBe(7);
    expect(report.job).toMatchObject({ total: 8, done: 8, running: false });
    const byName = new Map(report.frames.map((f: { fileName: string }) => [f.fileName, f]));
    expect(byName.get('good_0.fits')).toMatchObject({ grade: 'good', accepted: true, filter: 'H', exposureSec: 180 });
    expect(byName.get('soft.fits')).toMatchObject({ grade: 'poor', accepted: false });
    expect((byName.get('soft.fits') as { flags: string[] }).flags).toContain('very_soft');
    expect(byName.get('clouds.fits')).toMatchObject({ grade: 'poor', accepted: false });
    expect(byName.get('broken.fits')).toMatchObject({ measured: false, accepted: true });
    expect((byName.get('broken.fits') as { error: string }).error).toBeTruthy();
    expect(report.groups).toEqual([expect.objectContaining({ filter: 'H', count: 7 })]);
  });

  it('does not re-measure cached files', async () => {
    const res = await fetch(`${base()}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect((await res.json()).data).toMatchObject({ total: 0, running: false });
  });

  it('lets the user override the grade, and exports a CSV', async () => {
    const report = (await (await fetch(base())).json()).data;
    const soft = report.frames.find((f: { fileName: string }) => f.fileName === 'soft.fits');
    const review = (rejected: boolean | null) => fetch(`${baseUrl}/quality/review`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ relPath: soft.relPath, rejected }),
    });
    expect((await review(false)).status).toBe(200);
    let after = (await (await fetch(base())).json()).data;
    expect(after.frames.find((f: { fileName: string }) => f.fileName === 'soft.fits')).toMatchObject({ manual: 'accepted', accepted: true });

    const csvRes = await fetch(`${base()}.csv`);
    expect(csvRes.headers.get('content-type')).toContain('text/csv');
    const csv = await csvRes.text();
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('file,path,filter,exposure_s,date_obs,stars,hfr,fwhm,eccentricity,background,noise,grade,flags,weight,decision,accepted');
    expect(lines).toHaveLength(9);
    expect(lines.find(l => l.startsWith('soft.fits'))).toMatch(/,accepted,1$/);
    expect(lines.find(l => l.startsWith('clouds.fits'))).toMatch(/,auto,0$/);

    expect((await review(null)).status).toBe(200);
    after = (await (await fetch(base())).json()).data;
    expect(after.frames.find((f: { fileName: string }) => f.fileName === 'soft.fits')).toMatchObject({ manual: null, accepted: false });
  });

  it('validates input', async () => {
    expect((await fetch(`${baseUrl}/objects/NGC6888/sessions/yesterday/quality`)).status).toBe(422);
    const res = await fetch(`${baseUrl}/quality/review`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ relPath: '../../etc/passwd', rejected: true }),
    });
    expect(res.status).toBe(404);
  });
});
