import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-autoquality-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { stmts } from '../../server/lib/library/objects';
import { recordLibraryFile } from '../../server/lib/library/libraryFiles';
import { getQualityReport } from '../../server/lib/library/subFrameQuality';
import {
  noteImportedSubFrames,
  flushAutoQualityForTests,
  pendingAutoQualityNights,
  setImportBusyProbe,
} from '../../server/lib/library/autoQuality';
import { updateSettingsData } from '../../server/lib/telescopes';

const W = 160;
const H = 120;

/** Small 16-bit FITS with a grid of Gaussian stars. */
function fits(): Buffer {
  const card = (k: string, v: string) => `${k.padEnd(8)}= ${v.padStart(20)}`.padEnd(80);
  let header = [
    card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'), card('NAXIS1', String(W)), card('NAXIS2', String(H)),
    card('BZERO', '32768'), card('EXPTIME', '180'), `${'FILTER'.padEnd(8)}= 'H'`.padEnd(80), 'END'.padEnd(80),
  ].join('');
  header = header.padEnd(Math.ceil(header.length / 2880) * 2880);
  const px = new Float64Array(W * H).fill(1000);
  let seed = 3;
  for (let i = 0; i < px.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; px[i] += (seed % 21) - 10; }
  for (let k = 0; k < 16; k++) {
    const cx = 20 + (k % 4) * 35;
    const cy = 15 + Math.floor(k / 4) * 28;
    for (let y = cy - 8; y < cy + 8; y++) for (let x = cx - 8; x < cx + 8; x++) {
      px[y * W + x] += 4000 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * 1.5 ** 2));
    }
  }
  const data = Buffer.alloc(W * H * 2);
  for (let i = 0; i < px.length; i++) data.writeInt16BE(Math.round(px[i]) - 32768, i * 2);
  return Buffer.concat([Buffer.from(header, 'ascii'), data, Buffer.alloc((2880 - (data.length % 2880)) % 2880)]);
}

/** What an import path records: the file on disk plus its row. */
function importSubs(night: string, names: string[]) {
  const dir = path.join(LIBRARY_DIR, 'M27');
  fs.mkdirSync(dir, { recursive: true });
  const rows = names.map(fileName => {
    fs.writeFileSync(path.join(dir, fileName), fits());
    const row = { objectId: 'M27', folderName: 'M27', fileName, role: 'sub' as const, captureDate: night, captureTime: '230000' };
    recordLibraryFile(row);
    return row;
  });
  noteImportedSubFrames(rows);
}

beforeAll(() => {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  updateSettingsData({ groupObservingNights: true });
  stmts.upsertObject.run('M27', 'M27', 0, new Date().toISOString(), 0, null, 'M27', 'Dumbbell', null, null, null, null, null, null, null);
});

afterAll(() => {
  setImportBusyProbe(() => false);
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('measuring sub-frame quality after an import', () => {
  it('queues the night of imported FITS subs and measures it once the import is done', async () => {
    let busy = true;
    setImportBusyProbe(() => busy);
    importSubs('2026-09-10', ['a.fits', 'b.fits', 'c.fits']);
    // Previews and non-FITS files are not measured.
    noteImportedSubFrames([{ objectId: 'M27', fileName: 'a_thn.jpg', role: 'thumbnail', captureDate: '2026-09-11' }]);
    expect(pendingAutoQualityNights()).toEqual([{ objectId: 'M27', night: '2026-09-10' }]);

    // Still importing: nothing is measured yet.
    await flushAutoQualityForTests();
    expect(getQualityReport('M27', '2026-09-10').measured).toBe(0);
    expect(pendingAutoQualityNights()).toHaveLength(1);

    busy = false;
    await flushAutoQualityForTests();
    const report = getQualityReport('M27', '2026-09-10');
    expect(report.measured).toBe(3);
    expect(report.frames.every(f => f.grade !== null)).toBe(true);
    expect(pendingAutoQualityNights()).toEqual([]);
  });

  it('does nothing when the setting is off', async () => {
    updateSettingsData({ autoMeasureSubQuality: false });
    importSubs('2026-09-12', ['d.fits']);
    await flushAutoQualityForTests();
    expect(getQualityReport('M27', '2026-09-12').measured).toBe(0);
    expect(pendingAutoQualityNights()).toEqual([]);
    updateSettingsData({ autoMeasureSubQuality: true });
  });
});
