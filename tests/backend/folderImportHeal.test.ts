import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-folderheal-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { commitFolderImport } from '../../server/lib/library/import';
import { LIBRARY_DIR } from '../../server/lib/paths';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe('folder import partial-file heal', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  });

  it('overwrites a truncated file at its original name instead of writing a second copy', async () => {
    const root = tmpDir('heal-');
    const fileName = 'Stacked_10_M42_30.0s_IRCUT_20240115-220000.jpg';
    fs.mkdirSync(path.join(root, 'M42'));
    fs.writeFileSync(path.join(root, 'M42', fileName), Buffer.alloc(1000, 7));

    const plan = {
      rootPath: root,
      importJpg: true,
      objects: [{
        folderName: 'M42',
        targetObjectId: 'M42',
        targetFolderName: 'M42',
        sessionMap: { '2024-01-15': '2024-01-15' },
      }],
    };
    await commitFolderImport(plan);

    const landed = filesUnder(LIBRARY_DIR).filter(f => f.endsWith(fileName));
    expect(landed).toHaveLength(1);

    // Simulate a copy interrupted before it finished.
    fs.truncateSync(landed[0], 10);
    expect(fs.statSync(landed[0]).size).toBe(10);

    await commitFolderImport(plan);

    // The retry healed the same file rather than deduping to a second name.
    const after = filesUnder(LIBRARY_DIR).filter(f => f.includes('Stacked_10_M42_'));
    expect(after).toHaveLength(1);
    expect(path.basename(after[0])).toBe(fileName);
    expect(fs.statSync(after[0]).size).toBe(1000);
  });
});
