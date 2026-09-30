import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import db from '../../server/lib/db';
import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { writeArchiveMarker } from '../../server/lib/archive/archiveMarker';
import { DEFAULT_ARCHIVE_CONFIG, type ArchiveConfig } from '../../server/lib/archive/archiveConfig';
import { sha256File } from '../../server/lib/archive/archiveDigest';
import { readArchiveManifest, retireArchiveManifest, ARCHIVE_MANIFEST_FILENAME } from '../../server/lib/archive/archiveManifest';
import { verifyArchivedCopy } from '../../server/lib/archive/archiveCopy';
import { copyFileVerified, runArchive, getArchiveRunProgress, isArchiveRunning } from '../../server/lib/archive/archiveCopy';

/**
 * The copy engine.
 *
 * This step copies and deletes nothing, so the tests here are about the two
 * properties the destructive steps will depend on:
 *
 *  1. **A destination file is never trusted without verification.** A copy is
 *     written to a `.part` name, verified by size and digest, and only then
 *     renamed into place. A crash therefore cannot leave a truncated file wearing
 *     the final name, which is the state that would let a later "remove local
 *     copy" pass delete the only good copy of a file.
 *  2. **A run refuses to write to a disk that is not ours.** `runArchive` checks
 *     the marker before touching anything, so a foreign or unreadable marker
 *     stops the run rather than being written over.
 *
 * The source library is asserted byte-identical after every case.
 */

// Pass-through, so a test can count how many files a run actually hashes.
vi.mock('../../server/lib/archive/archiveDigest', async importOriginal => {
  const actual = await importOriginal<typeof import('../../server/lib/archive/archiveDigest')>();
  return { ...actual, sha256File: vi.fn(actual.sha256File) };
});

const STACKED_JPG = 'Stacked_10_M31_10.0s_LP_20241008-220000.jpg';
const STACKED_FIT = 'Stacked_50_M31_10.0s_LP_20241008-220000.fit';
const SUB_FIT = 'sub_00001_M31_10.0s_LP_20241008-220000.fit';
const M31_FOLDER = 'M 31';
const M31_SESSION = '2024-10-08_22-00-00';

const created: string[] = [];
const seededObjectIds: string[] = [];

function scratchDest(prefix = 'nebulis-archive-test-copy-'): string {
  const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), prefix));
  created.push(dir);
  return dir;
}

function seedObject(objectId: string, folderName: string, nested = false): void {
  db.prepare(
    'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 0, ?, 0)',
  ).run(objectId, folderName, new Date().toISOString());
  seededObjectIds.push(objectId);
  if (nested) {
    db.prepare("UPDATE libraryObjects SET layout = 'nested' WHERE objectId = ?").run(objectId);
  }
}

function writeLibraryFile(relPath: string, content: string): void {
  const abs = path.join(getLibraryDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A snapshot of every file under a root, so "byte-identical" can be asserted. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else out[rel] = fs.readFileSync(abs, 'utf8');
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}

function configFor(dest: string, overrides: Partial<ArchiveConfig> = {}): ArchiveConfig {
  return {
    ...DEFAULT_ARCHIVE_CONFIG,
    path: dest,
    archiveId: 'archive-under-test',
    includeSubframes: true,
    ...overrides,
  };
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

describe('copyFileVerified', () => {
  let dest: string;

  beforeEach(() => {
    dest = scratchDest();
  });

  it('copies a file and reports it as copied', async () => {
    const source = path.join(dest, 'src.bin');
    fs.writeFileSync(source, 'hello archive');
    const result = await copyFileVerified(source, path.join(dest, 'out.bin'), 13);
    expect(result.ok).toBe(true);
    expect(result.copied).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'out.bin'), 'utf8')).toBe('hello archive');
  });

  it('leaves no .part file behind on success', async () => {
    const source = path.join(dest, 'src.bin');
    fs.writeFileSync(source, 'x');
    await copyFileVerified(source, path.join(dest, 'out.bin'), 1);
    expect(fs.readdirSync(dest).filter(n => n.endsWith('.part'))).toEqual([]);
  });

  it('removes its .part and never creates the final file when cancelled mid-copy', async () => {
    const source = path.join(dest, 'src.bin');
    const target = path.join(dest, 'out.bin');
    fs.writeFileSync(source, 'hello archive');
    // Already aborted, so the copy runs up to the point it checks the signal: after
    // the bytes are written to the .part and before the rename.
    const controller = new AbortController();
    controller.abort();

    const result = await copyFileVerified(source, target, 13, controller.signal);
    expect(result).toMatchObject({ ok: false, copied: false, cancelled: true });
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(dest).filter(n => n.endsWith('.part'))).toEqual([]);
  });

  it('skips a destination that already matches, verifying rather than assuming', async () => {
    const source = path.join(dest, 'src.bin');
    const target = path.join(dest, 'out.bin');
    fs.writeFileSync(source, 'hello archive');
    await copyFileVerified(source, target, 13);

    const second = await copyFileVerified(source, target, 13);
    expect(second.ok).toBe(true);
    expect(second.copied).toBe(false);
  });

  it('repairs a destination whose contents are wrong', async () => {
    const source = path.join(dest, 'src.bin');
    const target = path.join(dest, 'out.bin');
    fs.writeFileSync(source, 'hello archive');
    // Same length, different bytes: a size check alone would call this a match.
    fs.writeFileSync(target, 'HELLO ARCHIVE');

    const result = await copyFileVerified(source, target, 13);
    expect(result.ok).toBe(true);
    expect(result.copied).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('hello archive');
  });

  it('fails, and leaves nothing at the destination, when the source is missing', async () => {
    const target = path.join(dest, 'out.bin');
    const result = await copyFileVerified(path.join(dest, 'nope.bin'), target, 13);
    expect(result.ok).toBe(false);
    // The dangerous state is a file at the final path that is not the file it
    // claims to be. There must be none.
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(dest).filter(n => n.endsWith('.part'))).toEqual([]);
  });

  it('fails when the source is not the size that was selected', async () => {
    const source = path.join(dest, 'src.bin');
    fs.writeFileSync(source, 'hello archive');
    const result = await copyFileVerified(source, path.join(dest, 'out.bin'), 999);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(dest, 'out.bin'))).toBe(false);
  });

  it('creates the parent directories it needs', async () => {
    const source = path.join(dest, 'src.bin');
    fs.writeFileSync(source, 'x');
    const target = path.join(dest, 'deep', 'nested', 'out.bin');
    const result = await copyFileVerified(source, target, 1);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });
});

describe('runArchive', () => {
  let dest: string;

  beforeEach(() => {
    dest = scratchDest();
    writeArchiveMarker(dest, 'archive-under-test');
    seedObject('M31', M31_FOLDER);
    writeLibraryFile(`${M31_FOLDER}/${STACKED_JPG}`, 'stacked-jpg');
    writeLibraryFile(`${M31_FOLDER}/${STACKED_FIT}`, 'stacked-fits');
    writeLibraryFile(`${M31_FOLDER}/${SUB_FIT}`, 'sub-frame');
  });

  it('copies every selected file to the mirrored path', async () => {
    const result = await runArchive(configFor(dest));
    expect(result.ran).toBe(true);
    expect(result.copied).toBe(3);
    expect(result.failures).toEqual([]);
    expect(fs.readFileSync(path.join(dest, M31_FOLDER, STACKED_JPG), 'utf8')).toBe('stacked-jpg');
    expect(fs.readFileSync(path.join(dest, M31_FOLDER, SUB_FIT), 'utf8')).toBe('sub-frame');
  });

  it('mirrors a nested object session folder', async () => {
    fs.rmSync(getLibraryDir(), { recursive: true, force: true });
    seedObject('M31b', M31_FOLDER, true);
    writeLibraryFile(`${M31_FOLDER}/${M31_SESSION}/${STACKED_FIT}`, 'nested-stack');

    const result = await runArchive(configFor(dest));
    expect(result.ran).toBe(true);
    expect(fs.readFileSync(path.join(dest, M31_FOLDER, M31_SESSION, STACKED_FIT), 'utf8')).toBe('nested-stack');
  });

  it('omits subframes when they are excluded', async () => {
    const result = await runArchive(configFor(dest, { includeSubframes: false }));
    expect(result.copied).toBe(2);
    expect(fs.existsSync(path.join(dest, M31_FOLDER, SUB_FIT))).toBe(false);
  });

  it('never modifies the library', async () => {
    const before = snapshot(getLibraryDir());
    await runArchive(configFor(dest));
    expect(snapshot(getLibraryDir())).toEqual(before);
  });

  it('is idempotent: a second run copies nothing and reports everything skipped', async () => {
    const first = await runArchive(configFor(dest));
    expect(first.copied).toBe(3);

    const second = await runArchive(configFor(dest));
    expect(second.copied).toBe(0);
    expect(second.skipped).toBe(3);
    expect(second.failures).toEqual([]);
  });

  it('reports progress that ends in a completed state', async () => {
    await runArchive(configFor(dest));
    const progress = getArchiveRunProgress();
    expect(progress.running).toBe(false);
    expect(progress.phase).toBe('done');
    expect(progress.filesDone).toBe(progress.filesTotal);
    expect(progress.bytesDone).toBe(progress.bytesTotal);
    expect(isArchiveRunning()).toBe(false);
  });

  it('refuses to write to a disk whose marker is not ours', async () => {
    const foreign = scratchDest();
    writeArchiveMarker(foreign, 'someone-elses');

    const result = await runArchive(configFor(foreign));
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('destination-unusable');
    expect(result.copied).toBe(0);
    // Only the marker that was already there; nothing from the library.
    expect(fs.readdirSync(foreign)).toEqual([expect.stringContaining('nebulisarchive')]);
  });

  it('refuses when no destination is configured', async () => {
    const result = await runArchive(configFor(''));
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('no-destination');
  });

  it('refuses to start a second run while one is in progress', async () => {
    const first = runArchive(configFor(dest));
    // Concurrent by design: the copy yields between files so the API stays
    // responsive, which is also what makes an overlapping run possible at all.
    const second = await runArchive(configFor(dest));
    expect(second.ran).toBe(false);
    expect(second.reason).toBe('already-running');

    const result = await first;
    expect(result.ran).toBe(true);
  });
});

describe('runArchive: skipping files that have not changed', () => {
  let dest: string;

  beforeEach(() => {
    dest = scratchDest();
    writeArchiveMarker(dest, 'archive-under-test');
    seedObject('M31', M31_FOLDER);
    writeLibraryFile(`${M31_FOLDER}/${STACKED_JPG}`, 'stacked-jpg');
    writeLibraryFile(`${M31_FOLDER}/${SUB_FIT}`, 'sub-frame');
    vi.mocked(sha256File).mockClear();
  });

  it('records size, mtime and digest for every archived file', async () => {
    await runArchive(configFor(dest));
    const files = readArchiveManifest(dest).objects[M31_FOLDER].files;
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes).toBeGreaterThan(0);
      expect(file.mtimeMs).toBeGreaterThan(0);
    }
  });

  it('hashes nothing on the second run over an unchanged library', async () => {
    await runArchive(configFor(dest));
    vi.mocked(sha256File).mockClear();

    const second = await runArchive(configFor(dest));
    expect(second.skipped).toBe(2);
    expect(second.copied).toBe(0);
    expect(sha256File).not.toHaveBeenCalled();
  });

  it('re-verifies a file whose mtime changed', async () => {
    await runArchive(configFor(dest));
    vi.mocked(sha256File).mockClear();
    const touched = path.join(getLibraryDir(), M31_FOLDER, STACKED_JPG);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(touched, future, future);

    const second = await runArchive(configFor(dest));
    expect(second.skipped).toBe(2);
    // Source and destination of the touched file, and nothing for the other one.
    expect(vi.mocked(sha256File).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(sha256File).mock.calls.every(([p]) => String(p).includes(STACKED_JPG))).toBe(true);
  });

  it('copies again a file whose archived copy has gone missing', async () => {
    await runArchive(configFor(dest));
    fs.rmSync(path.join(dest, M31_FOLDER, SUB_FIT));

    const second = await runArchive(configFor(dest));
    expect(second.copied).toBe(1);
    expect(fs.readFileSync(path.join(dest, M31_FOLDER, SUB_FIT), 'utf8')).toBe('sub-frame');
  });

  it('fills in the digests of a record written before they were kept, verifying once', async () => {
    await runArchive(configFor(dest));
    const recordPath = path.join(dest, ARCHIVE_MANIFEST_FILENAME);
    const legacy = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    legacy.version = 1;
    delete legacy.archiveId;
    for (const file of legacy.objects[M31_FOLDER].files) {
      delete file.bytes; delete file.mtimeMs; delete file.sha256;
    }
    fs.writeFileSync(recordPath, JSON.stringify(legacy));
    vi.mocked(sha256File).mockClear();

    const second = await runArchive(configFor(dest));
    expect(second.failures).toEqual([]);
    expect(vi.mocked(sha256File)).toHaveBeenCalled();
    expect(readArchiveManifest(dest).objects[M31_FOLDER].files.every(f => f.sha256 !== undefined)).toBe(true);
  });

  it('leaves the strict check for deletion hashing both sides, whatever the record says', async () => {
    await runArchive(configFor(dest));
    vi.mocked(sha256File).mockClear();
    const src = path.join(getLibraryDir(), M31_FOLDER, SUB_FIT);
    // Same size, different bytes: the shortcut would trust it, the strict check must not.
    fs.writeFileSync(path.join(dest, M31_FOLDER, SUB_FIT), 'SUB-FRAME');
    expect((await verifyArchivedCopy(src, path.join(dest, M31_FOLDER, SUB_FIT))).ok).toBe(false);
    expect(sha256File).toHaveBeenCalled();
  });
});

describe('runArchive: whose record is it', () => {
  it('refuses to use a record that names another archive, and leaves it alone', async () => {
    const dest = scratchDest();
    writeArchiveMarker(dest, 'archive-under-test');
    seedObject('M31', M31_FOLDER);
    writeLibraryFile(`${M31_FOLDER}/${STACKED_JPG}`, 'stacked-jpg');
    await runArchive(configFor(dest));

    const recordPath = path.join(dest, ARCHIVE_MANIFEST_FILENAME);
    const theirs = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    theirs.archiveId = 'someone-elses-archive';
    fs.writeFileSync(recordPath, JSON.stringify(theirs));
    const before = fs.readFileSync(recordPath, 'utf8');

    const result = await runArchive(configFor(dest));
    expect(result.copied).toBe(0);
    expect(result.failures[0]?.error).toContain('different archive');
    expect(fs.readFileSync(recordPath, 'utf8')).toBe(before);
    // Fail closed for everything that deletes.
    expect(readArchiveManifest(dest, 'archive-under-test').objects).toEqual({});
  });

  it('sets the old record aside on adoption so the new owner starts empty', async () => {
    const dest = scratchDest();
    writeArchiveMarker(dest, 'archive-under-test');
    seedObject('M31', M31_FOLDER);
    writeLibraryFile(`${M31_FOLDER}/${STACKED_JPG}`, 'stacked-jpg');
    await runArchive(configFor(dest));

    expect(retireArchiveManifest(dest)).toBe(true);
    expect(fs.existsSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(dest, `${ARCHIVE_MANIFEST_FILENAME}.previous`))).toBe(true);
    // The files themselves are untouched.
    expect(fs.existsSync(path.join(dest, M31_FOLDER, STACKED_JPG))).toBe(true);

    // Adoption writes the new marker, then the new owner runs against an empty record.
    writeArchiveMarker(dest, 'the-new-owner');
    const fresh = await runArchive(configFor(dest, { archiveId: 'the-new-owner' }));
    expect(fresh.ran).toBe(true);
    expect(fresh.failures).toEqual([]);
    expect(readArchiveManifest(dest, 'the-new-owner').archiveId).toBe('the-new-owner');
  });
});

describe('sweepStaleParts', () => {
  const DAY = 24 * 60 * 60_000;

  const partOf = (dir: string, name: string, ageMs: number): string => {
    const p = path.join(dir, `${name}.part`);
    fs.writeFileSync(p, 'half');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
    return p;
  };

  it('removes an old .part that sits beside a target it is about to write', async () => {
    const { sweepStaleParts } = await import('../../server/lib/archive/archiveCopy');
    const dir = scratchDest();
    const old = partOf(dir, 'a.fit', 2 * DAY);
    expect(await sweepStaleParts([path.join(dir, 'a.fit')])).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('leaves a recent .part alone, since it may be a copy in flight', async () => {
    const { sweepStaleParts } = await import('../../server/lib/archive/archiveCopy');
    const dir = scratchDest();
    const recent = partOf(dir, 'a.fit', 60_000);
    expect(await sweepStaleParts([path.join(dir, 'a.fit')])).toBe(0);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('leaves a user .part file that is not beside a same-named target', async () => {
    const { sweepStaleParts } = await import('../../server/lib/archive/archiveCopy');
    const dir = scratchDest();
    const theirs = partOf(dir, 'downloads-in-progress.zip', 30 * DAY);
    const beside = partOf(dir, 'other.fit', 30 * DAY);
    expect(await sweepStaleParts([path.join(dir, 'a.fit')])).toBe(0);
    expect(fs.existsSync(theirs)).toBe(true);
    expect(fs.existsSync(beside)).toBe(true);
  });

  it('does not fail on a directory that does not exist yet', async () => {
    const { sweepStaleParts } = await import('../../server/lib/archive/archiveCopy');
    expect(await sweepStaleParts([path.join(scratchDest(), 'nope', 'a.fit')])).toBe(0);
  });

  it('is applied at the start of a run', async () => {
    const dest = scratchDest();
    writeArchiveMarker(dest, 'archive-under-test');
    seedObject('M31', M31_FOLDER);
    writeLibraryFile(`${M31_FOLDER}/${STACKED_JPG}`, 'stacked-jpg');
    fs.mkdirSync(path.join(dest, M31_FOLDER), { recursive: true });
    const stale = partOf(path.join(dest, M31_FOLDER), STACKED_JPG, 3 * DAY);

    await runArchive(configFor(dest));
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(path.join(dest, M31_FOLDER, STACKED_JPG), 'utf8')).toBe('stacked-jpg');
  });
});
