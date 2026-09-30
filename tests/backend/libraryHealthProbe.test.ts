import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

import db from '../../server/lib/db';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { recordLibraryFiles } from '../../server/lib/library/libraryFiles';
import { analyzeLibrary, fixStaleRecords, fixMissingObjects, LibraryUnreadableError } from '../../server/lib/library/analyze';
import { getSubframeUsage, purgeAllSubframes } from '../../server/lib/library/cleanup';
import { probePath } from '../../server/lib/fsProbe';

/**
 * Library Health treats only a definite "no such file" as missing.
 *
 * `access(...).then(true, false)` turned every failure into "gone", so a permissions
 * fault or an I/O error on a share made healthy records look stale, and the repair
 * dropped them. A read error is "could not check", and a repair that cannot check
 * refuses rather than guess.
 */

const FOLDER = 'HealthProbe';
const SESSION = '2024-10-08_22-00-00';
const SUB = 'sub_00001_M31_10.0s_LP_20241008-220000.fit';
const STACKED = 'Stacked_10_M31_10.0s_LP_20241008-220000.jpg';
const OBJECT_ID = 'HEALTHPROBE';

const abs = (name: string): string => path.join(getLibraryDir(), FOLDER, SESSION, name);

function seed(): void {
  db.prepare(
    'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 2, ?, 0)',
  ).run(OBJECT_ID, FOLDER, new Date().toISOString());
  db.prepare("UPDATE libraryObjects SET layout = 'nested' WHERE objectId = ?").run(OBJECT_ID);
  for (const name of [SUB, STACKED]) {
    fs.mkdirSync(path.dirname(abs(name)), { recursive: true });
    fs.writeFileSync(abs(name), name);
  }
  recordLibraryFiles([
    { objectId: OBJECT_ID, folderName: FOLDER, sessionFolder: SESSION, fileName: SUB, role: 'sub' },
    { objectId: OBJECT_ID, folderName: FOLDER, sessionFolder: SESSION, fileName: STACKED, role: 'stacked' },
  ]);
}

const rowCount = (): number =>
  db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM libraryFiles WHERE objectId = ?').get(OBJECT_ID)?.n ?? 0;

/** Make `access` fail with `code` for one path and behave normally for the rest. */
function failAccessFor(target: string, code: string): void {
  const real = fsp.access.bind(fsp);
  vi.spyOn(fsp, 'access').mockImplementation(async (p, mode) => {
    if (String(p) === target) throw Object.assign(new Error(code), { code });
    return real(p, mode);
  });
}

beforeEach(seed);

afterEach(() => {
  vi.restoreAllMocks();
  db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(OBJECT_ID);
  db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(OBJECT_ID);
  fs.rmSync(path.join(getLibraryDir(), FOLDER), { recursive: true, force: true });
});

describe('probePath', () => {
  it('reports present, missing and error distinctly', async () => {
    expect(await probePath(abs(SUB))).toBe('present');
    expect(await probePath(abs('nope.fit'))).toBe('missing');
    // A file used as a directory is ENOTDIR, which is also a definite "not there".
    expect(await probePath(path.join(abs(SUB), 'child'))).toBe('missing');
    failAccessFor(abs(SUB), 'EACCES');
    expect(await probePath(abs(SUB))).toBe('error');
  });
});

describe('analyzeLibrary', () => {
  it('lists a genuinely missing file as stale', async () => {
    fs.rmSync(abs(SUB));
    const analysis = await analyzeLibrary();
    expect(analysis.staleRecords.count).toBe(1);
    expect(analysis.unreadable).toBe(0);
  });

  it.each(['EACCES', 'EIO'])('does not list a file as stale when the check fails with %s', async code => {
    failAccessFor(abs(SUB), code);
    const analysis = await analyzeLibrary();
    expect(analysis.staleRecords.count).toBe(0);
    expect(analysis.unreadable).toBe(1);
  });

  it('does not flag an object that never had files', async () => {
    db.prepare(
      'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 0, ?, 0)',
    ).run('EMPTYOBJ', 'EmptyObj', new Date().toISOString());
    try {
      const analysis = await analyzeLibrary();
      expect(analysis.missingObjects.map(o => o.objectId)).not.toContain('EMPTYOBJ');
    } finally {
      db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run('EMPTYOBJ');
    }
  });
});

describe('the repairs', () => {
  it('drop a record for a file that is really gone', async () => {
    fs.rmSync(abs(SUB));
    expect(await fixStaleRecords()).toEqual({ removed: 1 });
    expect(rowCount()).toBe(1);
  });

  it('refuse to run, and remove nothing, when any path could not be checked', async () => {
    fs.rmSync(abs(SUB));
    failAccessFor(abs(STACKED), 'EACCES');
    await expect(fixStaleRecords()).rejects.toBeInstanceOf(LibraryUnreadableError);
    expect(rowCount()).toBe(2);
  });

  it('refuse to retire an object when its folder could not be checked', async () => {
    failAccessFor(path.join(getLibraryDir(), FOLDER), 'EIO');
    await expect(fixMissingObjects()).rejects.toBeInstanceOf(LibraryUnreadableError);
    expect(db.prepare('SELECT deleted FROM libraryObjects WHERE objectId = ?').get(OBJECT_ID)).toEqual({ deleted: 0 });
  });
});

describe('subframe cleanup', () => {
  it('counts an unreadable subframe as neither present nor stale, and never purges it', async () => {
    failAccessFor(abs(SUB), 'EACCES');
    const usage = await getSubframeUsage();
    expect(usage).toMatchObject({ files: 0, staleRecords: 0, unreadable: 1 });

    const result = await purgeAllSubframes();
    expect(result).toMatchObject({ deleted: 0, staleRemoved: 0, unreadable: 1 });
    expect(rowCount()).toBe(2);
    expect(fs.existsSync(abs(SUB))).toBe(true);
  });
});
