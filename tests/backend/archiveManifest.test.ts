import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import db from '../../server/lib/db';
import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { writeArchiveMarker, ARCHIVE_MARKER_FILENAME } from '../../server/lib/archive/archiveMarker';
import { DEFAULT_ARCHIVE_CONFIG, type ArchiveConfig } from '../../server/lib/archive/archiveConfig';
import { runArchive } from '../../server/lib/archive/archiveCopy';
import {
  ARCHIVE_MANIFEST_FILENAME,
  EMPTY_ARCHIVE_MANIFEST,
  mergeArchiveRun,
  readArchiveManifest,
  readArchiveManifestResult,
  writeArchiveManifest,
  ARCHIVE_MANIFEST_BACKUP_FILENAME,
} from '../../server/lib/archive/archiveManifest';

/**
 * The archive's own record of what it put on the disk, and when.
 *
 * Retention cannot be written safely without this. "Prune anything older than N
 * days" against a directory listing would delete whatever the user happened to
 * leave in the archive folder, and there is no other way to answer the questions
 * that matter: which objects did *we* create, when did we last touch each one, and
 * which of their files are subframes (so the subframes-only mode can be
 * authoritative rather than re-deriving roles from filenames).
 *
 * The read path is deliberately fail-closed. A missing, truncated, or
 * unrecognisable manifest reads as empty, and an empty manifest means retention has
 * nothing to remove. A damaged file on a removable disk therefore disables pruning
 * rather than licensing it.
 */

const created: string[] = [];
const seededObjectIds: string[] = [];
const STACKED_JPG = 'Stacked_10_M31_10.0s_LP_20241008-220000.jpg';
const STACKED_FIT = 'Stacked_50_M31_10.0s_LP_20241008-220000.fit';
const SUB_FIT = 'sub_00001_M31_10.0s_LP_20241008-220000.fit';
const M31_FOLDER = 'M 31';
const M31_SESSION = '2024-10-08_22-00-00';
const ARCHIVE_ID = 'archive-under-test';

function scratchDest(prefix = 'nebulis-archive-test-manifest-'): string {
  const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), prefix));
  created.push(dir);
  return dir;
}

function seedObject(objectId: string, folderName: string, nested = false): void {
  db.prepare(
    'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 0, ?, 0)',
  ).run(objectId, folderName, new Date().toISOString());
  seededObjectIds.push(objectId);
  if (nested) db.prepare("UPDATE libraryObjects SET layout = 'nested' WHERE objectId = ?").run(objectId);
}

function writeLibraryFile(relPath: string, content: string): void {
  const abs = path.join(getLibraryDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function configFor(dest: string, overrides: Partial<ArchiveConfig> = {}): ArchiveConfig {
  return { ...DEFAULT_ARCHIVE_CONFIG, path: dest, archiveId: ARCHIVE_ID, includeSubframes: true, ...overrides };
}

beforeEach(() => {
  seededObjectIds.length = 0;
});

afterEach(() => {
  for (const objectId of seededObjectIds.splice(0)) {
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
  }
  fs.rmSync(getLibraryDir(), { recursive: true, force: true });
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('readArchiveManifest — fail closed', () => {
  let dest: string;

  beforeEach(() => {
    dest = scratchDest();
  });

  it('returns an empty manifest when there is none', () => {
    expect(readArchiveManifest(dest)).toEqual(EMPTY_ARCHIVE_MANIFEST);
  });

  it('returns an empty manifest for anything it cannot recognise', () => {
    // Every one of these means "we have no trustworthy record", and an empty
    // record removes nothing. Failing open here would let a truncated file turn
    // into a licence to delete.
    for (const text of [
      'not json',
      '[]',
      'null',
      '42',
      JSON.stringify({ version: 99, objects: { a: {} } }),
      JSON.stringify({ version: 1, objects: 'nope' }),
      JSON.stringify({ version: 1, objects: { 'M 31': { files: 'nope' } } }),
      JSON.stringify({ version: 1, objects: { 'M 31': { firstArchivedAt: 1, lastArchivedAt: null, files: [] } } }),
    ]) {
      fs.writeFileSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME), text, 'utf8');
      expect(readArchiveManifest(dest), `payload ${text}`).toEqual(EMPTY_ARCHIVE_MANIFEST);
    }
  });

  it('never creates the file while reading', () => {
    readArchiveManifest(dest);
    expect(fs.existsSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME))).toBe(false);
  });

  it('round-trips what it wrote', () => {
    const manifest = {
      version: 2 as const,
      updatedAt: '2026-03-10T12:00:00.000Z',
      objects: {
        'M 31': {
          objectId: 'M31',
          firstArchivedAt: '2026-01-01T00:00:00.000Z',
          lastArchivedAt: '2026-03-10T12:00:00.000Z',
          files: [{ relPath: STACKED_JPG, isSubframe: false }],
        },
      },
    };
    writeArchiveManifest(dest, manifest);
    expect(readArchiveManifest(dest)).toEqual(manifest);
  });

  it('reads a manifest written before object ids were recorded as unknown, not as a match', () => {
    // An older build wrote the same shape without `objectId`. Reading that as
    // "the object we are about to archive" would let a re-imported object inherit
    // the previous occupant's dates, so it has to read as an identity we do not
    // know. See `mergeArchiveRun`.
    fs.writeFileSync(
      path.join(dest, ARCHIVE_MANIFEST_FILENAME),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        objects: {
          'M 31': {
            firstArchivedAt: '2026-01-01T00:00:00.000Z',
            lastArchivedAt: '2026-01-01T00:00:00.000Z',
            files: [{ relPath: STACKED_JPG, isSubframe: false }],
          },
        },
      }),
      'utf8',
    );
    const manifest = readArchiveManifest(dest);
    expect(manifest.objects[M31_FOLDER].objectId).toBe('');
    // The files survive: they are still on the disk, so retention must still know
    // about them.
    expect(manifest.objects[M31_FOLDER].files).toEqual([{ relPath: STACKED_JPG, isSubframe: false }]);
  });

  it('does not let the manifest itself be mistaken for a capture', async () => {
    // The library's isRealFile rejects dot-prefixed names, so a manifest that
    // somehow ended up inside the library could not be archived back into itself.
    const { isRealFile } = await import('../../server/lib/telescopeFiles');
    expect(isRealFile(ARCHIVE_MANIFEST_FILENAME)).toBe(false);
    expect(isRealFile(ARCHIVE_MARKER_FILENAME)).toBe(false);
  });
});

describe('mergeArchiveRun', () => {
  it('records a new object with both timestamps set', () => {
    const merged = mergeArchiveRun(
      EMPTY_ARCHIVE_MANIFEST,
      [
        { objectId: 'M31', folderName: M31_FOLDER, relPath: STACKED_JPG, fileName: STACKED_JPG, sessionFolder: null, sourcePath: '/x', archiveRelPath: `${M31_FOLDER}/${STACKED_JPG}`, bytes: 1, role: 'stacked' as const },
      ],
      '2026-03-10T12:00:00.000Z',
    );
    expect(merged.objects[M31_FOLDER].firstArchivedAt).toBe('2026-03-10T12:00:00.000Z');
    expect(merged.objects[M31_FOLDER].lastArchivedAt).toBe('2026-03-10T12:00:00.000Z');
    expect(merged.objects[M31_FOLDER].files).toEqual([{ relPath: STACKED_JPG, isSubframe: false }]);
  });

  it('keeps the first archive date and advances the last on a later run', () => {
    const first = mergeArchiveRun(
      EMPTY_ARCHIVE_MANIFEST,
      candidatesWith([{ folder: M31_FOLDER, relPath: STACKED_JPG, role: 'stacked' }]),
      '2026-01-01T00:00:00.000Z',
    );
    const second = mergeArchiveRun(
      first,
      candidatesWith([{ folder: M31_FOLDER, relPath: STACKED_FIT, role: 'stacked' }]),
      '2026-03-10T12:00:00.000Z',
    );
    // firstArchivedAt is what answers "how long has this been archived"; moving it
    // forward on every run would make the answer meaningless.
    expect(second.objects[M31_FOLDER].firstArchivedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(second.objects[M31_FOLDER].lastArchivedAt).toBe('2026-03-10T12:00:00.000Z');
    expect(second.objects[M31_FOLDER].files.map(f => f.relPath).sort()).toEqual([STACKED_FIT, STACKED_JPG].sort());
  });

  it('marks subframes from the selection role, not from the filename', () => {
    const merged = mergeArchiveRun(
      EMPTY_ARCHIVE_MANIFEST,
      candidatesWith([
        { folder: M31_FOLDER, relPath: SUB_FIT, role: 'sub' },
        { folder: M31_FOLDER, relPath: STACKED_FIT, role: 'stacked' },
      ]),
      '2026-03-10T12:00:00.000Z',
    );
    const byPath = Object.fromEntries(merged.objects[M31_FOLDER].files.map(f => [f.relPath, f.isSubframe]));
    expect(byPath[SUB_FIT]).toBe(true);
    expect(byPath[STACKED_FIT]).toBe(false);
  });

  it('does not duplicate a file recorded by two runs', () => {
    const once = mergeArchiveRun(EMPTY_ARCHIVE_MANIFEST, candidatesWith([{ folder: M31_FOLDER, relPath: STACKED_JPG, role: 'stacked' }]), '2026-01-01T00:00:00.000Z');
    const twice = mergeArchiveRun(once, candidatesWith([{ folder: M31_FOLDER, relPath: STACKED_JPG, role: 'stacked' }]), '2026-03-10T12:00:00.000Z');
    expect(twice.objects[M31_FOLDER].files).toHaveLength(1);
  });

  it('leaves an object it did not touch alone', () => {
    const other = mergeArchiveRun(EMPTY_ARCHIVE_MANIFEST, candidatesWith([{ folder: 'M 42', relPath: STACKED_JPG, role: 'stacked' }]), '2026-01-01T00:00:00.000Z');
    const merged = mergeArchiveRun(other, candidatesWith([{ folder: M31_FOLDER, relPath: STACKED_JPG, role: 'stacked' }]), '2026-03-10T12:00:00.000Z');
    expect(merged.objects['M 42'].lastArchivedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(Object.keys(merged.objects).sort()).toEqual(['M 31', 'M 42']);
  });

  it('records which library object a folder belongs to', () => {
    const merged = mergeArchiveRun(
      EMPTY_ARCHIVE_MANIFEST,
      candidatesWith([{ folder: M31_FOLDER, relPath: STACKED_JPG, role: 'stacked', objectId: 'object-abc' }]),
      '2026-01-01T00:00:00.000Z',
    );
    expect(merged.objects[M31_FOLDER].objectId).toBe('object-abc');
  });

  it('restarts both clocks when a different object reuses the folder name', () => {
    // Delete object M 31 from the library, import a new M 31, archive it. With
    // retention on, the new object must not be handed to the pruner already
    // expired because the folder name matched.
    const stale = mergeArchiveRun(
      EMPTY_ARCHIVE_MANIFEST,
      candidatesWith([{ folder: M31_FOLDER, relPath: STACKED_JPG, role: 'stacked', objectId: 'old-object' }]),
      '2026-01-01T00:00:00.000Z',
    );
    const reused = mergeArchiveRun(
      stale,
      candidatesWith([{ folder: M31_FOLDER, relPath: STACKED_FIT, role: 'stacked', objectId: 'new-object' }]),
      '2026-07-01T00:00:00.000Z',
    );
    expect(reused.objects[M31_FOLDER].objectId).toBe('new-object');
    expect(reused.objects[M31_FOLDER].firstArchivedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(reused.objects[M31_FOLDER].lastArchivedAt).toBe('2026-07-01T00:00:00.000Z');
    // The previous occupant's file is still physically on the disk, so it stays
    // named by the record that is the only thing able to prune it.
    expect(reused.objects[M31_FOLDER].files.map(f => f.relPath).sort()).toEqual([STACKED_FIT, STACKED_JPG].sort());
  });

  it('restarts the clock for a folder whose recorded identity predates the field', () => {
    const legacy = {
      version: 2 as const,
      updatedAt: '2026-01-01T00:00:00.000Z',
      objects: {
        [M31_FOLDER]: {
          objectId: '',
          firstArchivedAt: '2026-01-01T00:00:00.000Z',
          lastArchivedAt: '2026-01-01T00:00:00.000Z',
          files: [{ relPath: STACKED_JPG, isSubframe: false }],
        },
      },
    };
    const merged = mergeArchiveRun(
      legacy,
      candidatesWith([{ folder: M31_FOLDER, relPath: STACKED_FIT, role: 'stacked', objectId: 'M31' }]),
      '2026-07-01T00:00:00.000Z',
    );
    expect(merged.objects[M31_FOLDER].firstArchivedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(merged.objects[M31_FOLDER].objectId).toBe('M31');
  });
});

describe('runArchive records what it archived', () => {
  let dest: string;

  beforeEach(() => {
    dest = scratchDest();
    writeArchiveMarker(dest, ARCHIVE_ID);
    seedObject('M31', M31_FOLDER, true);
    writeLibraryFile(`${M31_FOLDER}/${M31_SESSION}/${STACKED_JPG}`, 'stacked');
    writeLibraryFile(`${M31_FOLDER}/${M31_SESSION}/${SUB_FIT}`, 'sub');
  });

  it('writes a manifest naming the files it copied and their roles', async () => {
    const result = await runArchive(configFor(dest));
    expect(result.ran).toBe(true);

    const manifest = readArchiveManifest(dest);
    const entry = manifest.objects[M31_FOLDER];
    expect(entry).toBeDefined();
    const byPath = Object.fromEntries(entry.files.map(f => [f.relPath, f.isSubframe]));
    expect(byPath[`${M31_SESSION}/${STACKED_JPG}`]).toBe(false);
    expect(byPath[`${M31_SESSION}/${SUB_FIT}`]).toBe(true);
    expect(entry.lastArchivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not record files it did not copy', async () => {
    // Subframes excluded: they are not on the disk, so retention must never be
    // given a record that would have it look for them.
    await runArchive(configFor(dest, { includeSubframes: false }));
    const manifest = readArchiveManifest(dest);
    expect(manifest.objects[M31_FOLDER].files.map(f => f.relPath)).toEqual([`${M31_SESSION}/${STACKED_JPG}`]);
    expect(fs.existsSync(path.join(dest, M31_FOLDER, M31_SESSION, SUB_FIT))).toBe(false);
  });

  it('keeps the manifest inside the archive root', async () => {
    await runArchive(configFor(dest));
    expect(fs.existsSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(getLibraryDir(), ARCHIVE_MANIFEST_FILENAME))).toBe(false);
  });

  it('refuses to run over an unreadable manifest and leaves it exactly as it was', async () => {
    fs.writeFileSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME), 'corrupt', 'utf8');
    const result = await runArchive(configFor(dest));

    expect(result.copied).toBe(0);
    expect(result.failures.map(f => f.archiveRelPath)).toContain('(manifest)');
    expect(fs.readFileSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME), 'utf8')).toBe('corrupt');
    // Nothing landed without a record, so the record can be repaired later.
    expect(fs.existsSync(path.join(dest, M31_FOLDER))).toBe(false);
  });

  it('starts a record on an archive that has none', async () => {
    expect(readArchiveManifestResult(dest).status).toBe('absent');
    await runArchive(configFor(dest));
    expect(readArchiveManifestResult(dest).status).toBe('ok');
  });

  it('recovers from the rolling backup when the main manifest is damaged', async () => {
    await runArchive(configFor(dest));
    await runArchive(configFor(dest)); // the second write backs up the first good record
    fs.writeFileSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME), '{ truncated', 'utf8');

    const read = readArchiveManifestResult(dest);
    expect(read.status).toBe('ok');
    if (read.status === 'ok') {
      expect(read.fromBackup).toBe(true);
      expect(read.manifest.objects[M31_FOLDER].files.length).toBeGreaterThan(0);
    }

    // And a run repairs the main file from it.
    await runArchive(configFor(dest));
    expect(fs.readFileSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME), 'utf8')).toContain(M31_FOLDER);
  });

  it('does not let a damaged manifest replace the last good backup', () => {
    const good = mergeArchiveRun(EMPTY_ARCHIVE_MANIFEST, candidatesWith([{ folder: M31_FOLDER, relPath: `${M31_SESSION}/${STACKED_JPG}`, role: 'stacked' }]), '2026-03-01T00:00:00Z');
    writeArchiveManifest(dest, good);
    writeArchiveManifest(dest, { ...good, updatedAt: '2026-03-02T00:00:00Z' }); // backs up `good`
    fs.writeFileSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME), 'corrupt', 'utf8');
    writeArchiveManifest(dest, { ...good, updatedAt: '2026-03-03T00:00:00Z' }); // must not back up 'corrupt'

    const backup = fs.readFileSync(path.join(dest, ARCHIVE_MANIFEST_BACKUP_FILENAME), 'utf8');
    expect(backup).not.toContain('corrupt');
    expect(backup).toContain(M31_FOLDER);
  });

  it('leaves the old manifest intact when the write dies before the rename', () => {
    const good = mergeArchiveRun(EMPTY_ARCHIVE_MANIFEST, candidatesWith([{ folder: M31_FOLDER, relPath: `${M31_SESSION}/${STACKED_JPG}`, role: 'stacked' }]), '2026-03-01T00:00:00Z');
    writeArchiveManifest(dest, good);
    const before = fs.readFileSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME), 'utf8');

    // A directory squatting on the tmp name makes the temp write fail, which is the
    // same position a crash between "start writing" and "rename" leaves the disk in.
    fs.mkdirSync(path.join(dest, `${ARCHIVE_MANIFEST_FILENAME}.tmp`));
    expect(() => writeArchiveManifest(dest, { ...good, updatedAt: '2026-04-01T00:00:00Z' })).toThrow();

    expect(fs.readFileSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME), 'utf8')).toBe(before);
  });
});

/** Minimal candidates, so the merge can be tested without touching a disk. */
function candidatesWith(entries: Array<{ folder: string; relPath: string; role: 'sub' | 'stacked'; objectId?: string }>) {
  return entries.map(e => ({
    objectId: e.objectId ?? e.folder,
    folderName: e.folder,
    relPath: e.relPath,
    fileName: e.relPath,
    sessionFolder: null,
    sourcePath: `/library/${e.folder}/${e.relPath}`,
    archiveRelPath: `${e.folder}/${e.relPath}`,
    bytes: 1,
    role: e.role,
  }));
}

describe('manifest version 2', () => {
  it('reads a version 1 record, with no digests recorded', () => {
    const dest = scratchDest();
    fs.writeFileSync(
      path.join(dest, ARCHIVE_MANIFEST_FILENAME),
      JSON.stringify({ version: 1, updatedAt: '', objects: { 'M 31': { objectId: 'M31', firstArchivedAt: 'a', lastArchivedAt: 'b', files: [{ relPath: 'x.jpg', isSubframe: false }] } } }),
    );
    const read = readArchiveManifestResult(dest);
    expect(read.status).toBe('ok');
    if (read.status === 'ok') expect(read.manifest.objects['M 31'].files[0].sha256).toBeUndefined();
  });

  it('drops a half-recorded digest instead of trusting it', () => {
    const dest = scratchDest();
    fs.writeFileSync(
      path.join(dest, ARCHIVE_MANIFEST_FILENAME),
      JSON.stringify({ version: 2, updatedAt: '', objects: { 'M 31': { objectId: 'M31', firstArchivedAt: 'a', lastArchivedAt: 'b', files: [{ relPath: 'x.jpg', isSubframe: false, bytes: 3, sha256: 'nothex' }] } } }),
    );
    expect(readArchiveManifest(dest).objects['M 31'].files[0]).toEqual({ relPath: 'x.jpg', isSubframe: false });
  });

  it('treats a record naming another archive as unreadable', () => {
    const dest = scratchDest();
    fs.writeFileSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME), JSON.stringify({ version: 2, archiveId: 'theirs', updatedAt: '', objects: {} }));
    expect(readArchiveManifestResult(dest, 'mine').status).toBe('unreadable');
    expect(readArchiveManifestResult(dest, 'theirs').status).toBe('ok');
    // A record with no id (written before it was kept) is accepted.
    fs.writeFileSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME), JSON.stringify({ version: 2, updatedAt: '', objects: {} }));
    expect(readArchiveManifestResult(dest, 'mine').status).toBe('ok');
  });
});
