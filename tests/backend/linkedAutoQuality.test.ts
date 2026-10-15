import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-linked-autoquality-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// The queue itself is covered by autoQuality.test.ts; here only what the
// linked-folder paths hand it matters.
const noted = vi.hoisted(() => [] as { objectId: string; fileName: string; role?: string; captureDate?: string | null; sourceId?: string | null }[]);
vi.mock('../../server/lib/library/autoQuality', async importOriginal => ({
  ...(await importOriginal<typeof import('../../server/lib/library/autoQuality')>()),
  noteImportedSubFrames: (rows: typeof noted) => { noted.push(...rows); },
}));

import db from '../../server/lib/db';
import { ensureLibraryDir } from '../../server/lib/library/objects';
import { commitSource, rescanSource } from '../../server/lib/library/librarySources';

const SETTINGS = { importJpg: true, importFits: true, importSubFrames: true };
const roots: string[] = [];

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  db.prepare('DELETE FROM libraryObjects').run();
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM librarySources').run();
  ensureLibraryDir();
  noted.length = 0;
});

function makeRoot(): { root: string; sub: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-linked-quality-'));
  roots.push(root);
  const obj = path.join(root, 'Galaxies', 'M 31 - Andromeda');
  const sub = path.join(obj, 'M 31_sub');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(obj, 'Stacked_60_M 31_10.0s_IRCUT_20260101-200000.jpg'), 'a'.repeat(100));
  fs.writeFileSync(path.join(sub, 'Light_M 31_10.0s_IRCUT_20260101-200500.fit'), 'f'.repeat(80));
  return { root, sub };
}

const subs = () => noted.filter(r => r.role === 'sub');

describe('linked folders feed the sub-frame quality queue', () => {
  it('hands over the subs recorded when a folder is linked', () => {
    const { root } = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x', importOptions: { importSubFrames: true } });
    expect(subs()).toEqual([expect.objectContaining({ fileName: 'Light_M 31_10.0s_IRCUT_20260101-200500.fit', sourceId })]);
  });

  it('hands over only the subs a rescan adds or changes', () => {
    const { root, sub } = makeRoot();
    const { sourceId } = commitSource(root, SETTINGS, { label: 'x', importOptions: { importSubFrames: true } });
    noted.length = 0;

    rescanSource(sourceId, SETTINGS);
    expect(subs()).toEqual([]);

    fs.writeFileSync(path.join(sub, 'Light_M 31_10.0s_IRCUT_20260101-201000.fit'), 'g'.repeat(80));
    rescanSource(sourceId, SETTINGS);
    expect(subs().map(r => r.fileName)).toEqual(['Light_M 31_10.0s_IRCUT_20260101-201000.fit']);
  });
});
