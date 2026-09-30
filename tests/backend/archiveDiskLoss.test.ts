import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

import db from '../../server/lib/db';
import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { setObjectLayout } from '../../server/lib/library/libraryLayout';
import { ARCHIVE_MARKER_FILENAME, writeArchiveMarker } from '../../server/lib/archive/archiveMarker';
import { ARCHIVE_MANIFEST_FILENAME } from '../../server/lib/archive/archiveManifest';
import { DEFAULT_ARCHIVE_CONFIG, getArchiveConfig, setArchiveConfig, type ArchiveConfig } from '../../server/lib/archive/archiveConfig';
import { copyFileVerified, runArchive } from '../../server/lib/archive/archiveCopy';
import { createDiskGuard, DiskGoneError, DISK_LOST_MESSAGE, type DiskGuard } from '../../server/lib/archive/archiveDiskGuard';
import { runArchivePipeline } from '../../server/lib/archive/archivePipeline';

/**
 * A disk that goes away during a run.
 *
 * The marker was checked once, before the run. On Linux and in Docker the mount point outlives the mount, so after a
 * disk was pulled the run kept writing into the empty folder on the app's own disk (1,392 files in the Docker lab)
 * and reported success. The rules that stop it:
 *
 *   - a run never creates the archive root, only folders below it,
 *   - the disk is re-proven (root exists, same device, our marker) before and after every write,
 *   - what a write added is taken away again when the disk turns out to be gone,
 *   - nothing is recorded, deleted or pruned on the strength of a run that ended that way.
 */

const created: string[] = [];
const seededObjectIds: string[] = [];
const ARCHIVE_ID = 'archive-disk-loss-test';
const M31 = 'M 31';
const SESSION = '2024-10-08_22-00-00';

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), 'nebulis-archive-test-diskloss-'));
  created.push(dir);
  return dir;
}

function seedObject(objectId: string, folderName: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 0, ?, 0)',
  ).run(objectId, folderName, new Date().toISOString());
  seededObjectIds.push(objectId);
  setObjectLayout(objectId, 'nested');
}

function write(relPath: string, content: string): void {
  const abs = path.join(getLibraryDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function configFor(dest: string, overrides: Partial<ArchiveConfig> = {}): ArchiveConfig {
  return { ...DEFAULT_ARCHIVE_CONFIG, path: dest, archiveId: ARCHIVE_ID, includeSubframes: true, ...overrides };
}

const stacked = (n: number): string => `Stacked_${n}_M31_10.0s_LP_20241008-2200${String(n).padStart(2, '0')}.jpg`;

/** `count` stacked files in one session of M 31. */
function seedFiles(count: number): string[] {
  seedObject('M31', M31);
  const names: string[] = [];
  for (let i = 1; i <= count; i++) {
    write(`${M31}/${SESSION}/${stacked(i)}`, `content-${i}`);
    names.push(stacked(i));
  }
  return names;
}

beforeEach(() => {
  seededObjectIds.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  setArchiveConfig(DEFAULT_ARCHIVE_CONFIG);
  for (const objectId of seededObjectIds.splice(0)) {
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(objectId);
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
  }
  fs.rmSync(getLibraryDir(), { recursive: true, force: true });
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('createDiskGuard.assertPresent', () => {
  it('passes for the disk it started on', async () => {
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    const guard = await createDiskGuard(dest, ARCHIVE_ID);
    await expect(guard.assertPresent()).resolves.toBeUndefined();
  });

  it('fails once the root is gone', async () => {
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    const guard = await createDiskGuard(dest, ARCHIVE_ID);
    fs.rmSync(dest, { recursive: true });
    await expect(guard.assertPresent()).rejects.toBeInstanceOf(DiskGoneError);
  });

  it('fails once the marker is gone: an empty folder is not our disk', async () => {
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    const guard = await createDiskGuard(dest, ARCHIVE_ID);
    fs.rmSync(path.join(dest, ARCHIVE_MARKER_FILENAME));
    await expect(guard.assertPresent()).rejects.toThrow(DISK_LOST_MESSAGE);
  });

  it('fails when a different install\'s marker is in its place', async () => {
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    const guard = await createDiskGuard(dest, ARCHIVE_ID);
    writeArchiveMarker(dest, 'someone-elses-archive');
    await expect(guard.assertPresent()).rejects.toBeInstanceOf(DiskGoneError);
  });

  it('refuses to start on a root that is not there', async () => {
    const dest = scratchDir();
    fs.rmSync(dest, { recursive: true });
    await expect(createDiskGuard(dest, ARCHIVE_ID)).rejects.toBeInstanceOf(DiskGoneError);
  });
});

describe('createDiskGuard.mkdirBelowRoot: the root is never created', () => {
  it('creates the folders below the root and reports which ones it made', async () => {
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    fs.mkdirSync(path.join(dest, 'M 31'));
    const guard = await createDiskGuard(dest, ARCHIVE_ID);
    const made = await guard.mkdirBelowRoot(path.join(dest, 'M 31', SESSION, 'Thumbnail'));
    expect(made).toEqual([path.join(dest, 'M 31', SESSION), path.join(dest, 'M 31', SESSION, 'Thumbnail')]);
    expect(fs.existsSync(path.join(dest, 'M 31', SESSION, 'Thumbnail'))).toBe(true);
  });

  it('a missing root is a disconnected disk: it throws and creates nothing', async () => {
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    const guard = await createDiskGuard(dest, ARCHIVE_ID);
    fs.rmSync(dest, { recursive: true });
    await expect(guard.mkdirBelowRoot(path.join(dest, 'M 31', SESSION))).rejects.toBeInstanceOf(DiskGoneError);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('refuses a folder outside the root', async () => {
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    const guard = await createDiskGuard(dest, ARCHIVE_ID);
    await expect(guard.mkdirBelowRoot(path.join(dest, '..', 'elsewhere'))).rejects.toThrow(/outside the archive root/);
  });
});

describe('copyFileVerified with a guard', () => {
  function sourceFile(content: string): { p: string; bytes: number } {
    const dir = scratchDir();
    const p = path.join(dir, 'src.jpg');
    fs.writeFileSync(p, content);
    return { p, bytes: Buffer.byteLength(content) };
  }

  it('copies normally while the disk is there', async () => {
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    const guard = await createDiskGuard(dest, ARCHIVE_ID);
    const src = sourceFile('hello');
    const target = path.join(dest, 'M 31', SESSION, 'a.jpg');
    const out = await copyFileVerified(src.p, target, src.bytes, undefined, undefined, guard);
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('hello');
  });

  it('with the disk gone before the write: reports it, and rebuilds nothing on the local disk', async () => {
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    const guard = await createDiskGuard(dest, ARCHIVE_ID);
    const src = sourceFile('hello');
    fs.rmSync(dest, { recursive: true });
    const out = await copyFileVerified(src.p, path.join(dest, 'M 31', SESSION, 'a.jpg'), src.bytes, undefined, undefined, guard);
    expect(out.ok).toBe(false);
    expect(out.diskGone).toBe(true);
    expect(fs.existsSync(dest)).toBe(false);          // the old code recreated the whole path here
  });

  it('with an empty folder where the disk was (Linux mount point): refuses before writing anything', async () => {
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    const guard = await createDiskGuard(dest, ARCHIVE_ID);
    const src = sourceFile('hello');
    fs.rmSync(path.join(dest, ARCHIVE_MARKER_FILENAME));   // the folder is still there, the disk is not
    const out = await copyFileVerified(src.p, path.join(dest, 'M 31', SESSION, 'a.jpg'), src.bytes, undefined, undefined, guard);
    expect(out.diskGone).toBe(true);
    expect(fs.readdirSync(dest)).toEqual([]);           // no folder, no part file, nothing
  });

  it('a disk that vanishes DURING the copy: the file, its part and the folders it made are taken away', async () => {
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    const real = await createDiskGuard(dest, ARCHIVE_ID);
    let calls = 0;
    // Present for the check before the write, gone for the check after it.
    const flaky: DiskGuard = {
      root: real.root,
      mkdirBelowRoot: dir => real.mkdirBelowRoot(dir),
      assertPresent: async () => {
        calls++;
        if (calls >= 2) throw new DiskGoneError(DISK_LOST_MESSAGE);
      },
    };
    const src = sourceFile('hello');
    const target = path.join(dest, 'M 31', SESSION, 'a.jpg');
    const out = await copyFileVerified(src.p, target, src.bytes, undefined, undefined, flaky);
    expect(out.diskGone).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
    expect(fs.existsSync(path.join(dest, 'M 31'))).toBe(false);     // the folders this call created are gone too
    expect(fs.readdirSync(dest)).toEqual([ARCHIVE_MARKER_FILENAME]);
  });

  it('never removes a folder it did not create', async () => {
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    fs.mkdirSync(path.join(dest, 'M 31'));
    fs.writeFileSync(path.join(dest, 'M 31', 'earlier.jpg'), 'from an earlier run');
    const real = await createDiskGuard(dest, ARCHIVE_ID);
    let calls = 0;
    const flaky: DiskGuard = {
      root: real.root,
      mkdirBelowRoot: dir => real.mkdirBelowRoot(dir),
      assertPresent: async () => { if (++calls >= 2) throw new DiskGoneError(DISK_LOST_MESSAGE); },
    };
    const src = sourceFile('hello');
    await copyFileVerified(src.p, path.join(dest, 'M 31', SESSION, 'a.jpg'), src.bytes, undefined, undefined, flaky);
    expect(fs.readFileSync(path.join(dest, 'M 31', 'earlier.jpg'), 'utf8')).toBe('from an earlier run');
    expect(fs.existsSync(path.join(dest, 'M 31', SESSION))).toBe(false);
  });
});

/** Run an archive of `count` files and pull the disk (delete the marker) once `after` files have been copied. */
async function runPullingDiskAfter(dest: string, count: number, after: number, overrides: Partial<ArchiveConfig> = {}) {
  seedFiles(count);
  writeArchiveMarker(dest, ARCHIVE_ID);
  const realCopy = fsp.copyFile.bind(fsp);
  let copies = 0;
  vi.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
    await realCopy(from, to, mode);
    if (++copies === after) fs.rmSync(path.join(dest, ARCHIVE_MARKER_FILENAME));
  });
  return runArchive(configFor(dest, overrides));
}

describe('a run whose disk goes away', () => {
  it('stops, says so, and leaves only files that are on the disk intact', async () => {
    const dest = scratchDir();
    const result = await runPullingDiskAfter(dest, 6, 3);

    expect(result.diskLost).toBe(true);
    expect(result.failures.some(f => f.error === DISK_LOST_MESSAGE)).toBe(true);
    // The two files finished before the pull are intact. The third (its copy triggered the pull) is unwound, and
    // nothing after it was attempted.
    const onDisk = fs.readdirSync(path.join(dest, M31, SESSION)).sort();
    expect(onDisk).toEqual([stacked(1), stacked(2)]);
    for (const n of [1, 2]) {
      expect(fs.readFileSync(path.join(dest, M31, SESSION, stacked(n)), 'utf8')).toBe(`content-${n}`);
    }
    expect(result.copied).toBeLessThan(6);
  });

  it('does not write the manifest into the emptied disk', async () => {
    const dest = scratchDir();
    await runPullingDiskAfter(dest, 6, 3);
    expect(fs.existsSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME))).toBe(false);
    expect(fs.readdirSync(dest)).toEqual([M31]);
  });

  it('a run that finds the marker missing at the start is refused, as before, and writes nothing', async () => {
    const dest = scratchDir();
    seedFiles(3);
    const result = await runArchive(configFor(dest));     // no marker was ever written
    expect(result.ran).toBe(false);
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  it('the pipeline neither removes local sub-frames nor stamps the schedule after a lost disk', async () => {
    const dest = scratchDir();
    seedObject('M31', M31);
    const subs: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const name = `sub_0000${i}_M31_10.0s_LP_20241008-2200${String(i).padStart(2, '0')}.fit`;
      write(`${M31}/${SESSION}/${name}`, `sub-${i}`);
      subs.push(name);
    }
    writeArchiveMarker(dest, ARCHIVE_ID);
    const realCopy = fsp.copyFile.bind(fsp);
    let copies = 0;
    vi.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
      await realCopy(from, to, mode);
      if (++copies === 3) fs.rmSync(path.join(dest, ARCHIVE_MARKER_FILENAME));
    });

    const config = configFor(dest, { removeLocalAfter: true, retentionEnabled: true, retentionDays: 1 });
    setArchiveConfig({ ...config, lastRunAt: '' });
    const result = await runArchivePipeline(config, new Date(), 'manual');

    expect(result.diskLost).toBe(true);
    expect(result.localRemoved).toBe(0);
    expect(result.retentionRemoved).toBe(0);
    for (const name of subs) expect(fs.existsSync(path.join(getLibraryDir(), M31, SESSION, name)), `${name} kept`).toBe(true);
    expect(getArchiveConfig().lastRunAt).toBe('');
    expect(getArchiveConfig().lastResult).toContain('disconnected');
  });
});
