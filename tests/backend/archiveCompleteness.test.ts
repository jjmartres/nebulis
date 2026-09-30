import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import db from '../../server/lib/db';
import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { setObjectLayout } from '../../server/lib/library/libraryLayout';
import { getLibraryFilesForObject } from '../../server/lib/library/libraryFiles';
import { writeArchiveMarker } from '../../server/lib/archive/archiveMarker';
import { readArchiveManifest, writeArchiveManifest } from '../../server/lib/archive/archiveManifest';
import { DEFAULT_ARCHIVE_CONFIG, setArchiveConfig, type ArchiveConfig } from '../../server/lib/archive/archiveConfig';
import { selectArchiveFiles } from '../../server/lib/archive/archiveSelect';
import { runArchive } from '../../server/lib/archive/archiveCopy';
import { listArchivedObjects } from '../../server/lib/archive/archiveBrowse';
import { restoreArchivedFiles } from '../../server/lib/archive/archiveRestore';
import { applyArchiveRetention, planArchiveRetention } from '../../server/lib/archive/archiveRetention';
import { removeVerifiedLocalSubframes } from '../../server/lib/archive/archiveLocalRemoval';

/**
 * The archive holds EVERYTHING in the library folder.
 *
 * That is the promise the feature makes, and an earlier version broke it silently: it walked session folders only
 * and kept files with a known image extension, so an object's `processed/` (the user's finished images), the
 * `_archive/` calibration frames, the shared `RESTACKED/`, and any `.json`/`.xisf`/`.txt` in a session never reached
 * the disk. Nothing failed and nothing was reported; the backup was simply incomplete.
 *
 * The first block is an oracle written independently of the code under test: it lists every file on disk in the
 * library, removes only what the module documents as bookkeeping, and requires the selection to match exactly. A
 * new kind of file that the selection forgets makes it fail without anyone having to think of that kind first.
 */

const created: string[] = [];
const seededObjectIds: string[] = [];
const ARCHIVE_ID = 'archive-completeness-test';

const M31 = 'M 31';
const SESSION = '2024-10-08_22-00-00';
const STACKED_JPG = 'Stacked_10_M31_10.0s_LP_20241008-220000.jpg';
const SUB_FIT = 'sub_00001_M31_10.0s_LP_20241008-220000.fit';

function seedObject(objectId: string, folderName: string, opts: { deleted?: boolean } = {}): void {
  db.prepare(
    'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 0, ?, ?)',
  ).run(objectId, folderName, new Date().toISOString(), opts.deleted ? 1 : 0);
  seededObjectIds.push(objectId);
  setObjectLayout(objectId, 'nested');
}

function write(relPath: string, content: string): void {
  const abs = path.join(getLibraryDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), 'nebulis-archive-test-complete-'));
  created.push(dir);
  return dir;
}

function configFor(dest: string, overrides: Partial<ArchiveConfig> = {}): ArchiveConfig {
  return { ...DEFAULT_ARCHIVE_CONFIG, path: dest, archiveId: ARCHIVE_ID, includeSubframes: true, ...overrides };
}

/** Every real (non-bookkeeping) file under a folder, as posix paths. Written here, not imported: this is the oracle. */
function everythingUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name.toLowerCase() === 'thumbs.db') continue;   // documented bookkeeping
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
      else if (ent.isFile()) out.push(rel);                                              // symlinks are neither
    }
  };
  walk(root, '');
  return out.sort();
}

/**
 * A library that has one of everything Nebulis puts in it, plus the bookkeeping it must NOT copy.
 * Returns nothing: assertions read the disk.
 */
function seedRichLibrary(): void {
  seedObject('M31', M31);
  // Ordinary session content, in the extensions the importer knows...
  write(`${M31}/${SESSION}/${STACKED_JPG}`, 'stacked');
  write(`${M31}/${SESSION}/${SUB_FIT}`, 'sub');
  write(`${M31}/${SESSION}/stacked.jpg`, 'preview');
  // ...and in ones it does not: a Dwarf's shotsInfo.json, a log, a PixInsight project file.
  write(`${M31}/${SESSION}/shotsInfo.json`, '{"shots":1}');
  write(`${M31}/${SESSION}/session.log`, 'log');
  write(`${M31}/${SESSION}/Thumbnail/frame1.jpg`, 'thumb-in-session');
  // The user's finished images, including formats the viewer cannot render and one in a sub-folder.
  write(`${M31}/processed/final.jpg`, 'final');
  write(`${M31}/processed/final.xisf`, 'xisf');
  write(`${M31}/processed/project.psd`, 'psd');
  write(`${M31}/processed/2024/variant.tif`, 'variant');
  // A loose file at the object's root.
  write(`${M31}/notes.txt`, 'my notes');
  // Top-level library folders that are not objects.
  write('_archive/tele-1/CALI_FRAME/cali_001.fits', 'dark');
  write('_archive/tele-1/DWARF_DARK/dark_001.fits', 'dark2');
  write('RESTACKED/M 31/megastack.jpg', 'restack');
  write('Stray Folder/whatever.jpg', 'stray');
  // A second, live object with a single file, so "everything" spans objects.
  seedObject('M42', 'M 42');
  write('M 42/2024-11-01_21-00-00/Stacked_10_M42_10.0s_LP_20241101-210000.jpg', 'm42');
  // Bookkeeping that must never be copied.
  write(`${M31}/.nebulis-files.json`, '{}');
  write(`${M31}/${SESSION}/.thumbs/x.fits.v3.jpg`, 'cache');
  write(`${M31}/${SESSION}/.DS_Store`, 'junk');
  write(`${M31}/${SESSION}/Thumbs.db`, 'junk');
  write(`${M31}/${SESSION}/._stacked.jpg`, 'appledouble');
  write('.library-marker', 'marker');
  write('@src/src_abc/linked.jpg', 'linked namespace');
}

beforeEach(() => {
  seededObjectIds.length = 0;
});

afterEach(() => {
  setArchiveConfig(DEFAULT_ARCHIVE_CONFIG);
  for (const objectId of seededObjectIds.splice(0)) {
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(objectId);
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
  }
  fs.rmSync(getLibraryDir(), { recursive: true, force: true });
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('completeness oracle: the selection is exactly everything in the library', () => {
  it('selects every real file, and nothing that is documented bookkeeping', () => {
    seedRichLibrary();
    const expected = everythingUnder(getLibraryDir()).filter(p => !p.startsWith('@src/'));
    const selected = selectArchiveFiles(DEFAULT_ARCHIVE_CONFIG_ALL).candidates.map(c => c.archiveRelPath).sort();
    expect(selected).toEqual(expected);
    // The premise: the oracle really did see the awkward files, so this cannot pass vacuously.
    for (const must of [
      `${M31}/processed/final.jpg`, `${M31}/processed/final.xisf`, `${M31}/processed/2024/variant.tif`,
      `${M31}/${SESSION}/shotsInfo.json`, `${M31}/notes.txt`,
      '_archive/tele-1/CALI_FRAME/cali_001.fits', 'RESTACKED/M 31/megastack.jpg', 'Stray Folder/whatever.jpg',
    ]) expect(expected, `${must} is in the library`).toContain(must);
  });

  it('never selects the bookkeeping', () => {
    seedRichLibrary();
    const selected = selectArchiveFiles(DEFAULT_ARCHIVE_CONFIG_ALL).candidates.map(c => c.archiveRelPath);
    for (const p of selected) {
      expect(p.split('/').some(seg => seg.startsWith('.')), `${p} has a dot segment`).toBe(false);
      expect(p.toLowerCase().endsWith('thumbs.db')).toBe(false);
      expect(p.startsWith('@src/')).toBe(false);
    }
  });
});

const DEFAULT_ARCHIVE_CONFIG_ALL: ArchiveConfig = { ...DEFAULT_ARCHIVE_CONFIG, scope: 'all', includeSubframes: true };

describe('what each kind of file is recorded as', () => {
  it('a processed image is never a sub-frame, even when its name looks like one, and survives "no sub-frames"', () => {
    seedObject('M31', M31);
    write(`${M31}/processed/${SUB_FIT}`, 'a finished image that happens to be named like a sub');
    write(`${M31}/processed/final.jpg`, 'final');
    const selection = selectArchiveFiles({ ...DEFAULT_ARCHIVE_CONFIG, scope: 'all', includeSubframes: false });
    expect(selection.candidates.map(c => c.relPath).sort()).toEqual(['processed/final.jpg', `processed/${SUB_FIT}`].sort());
    expect(selection.candidates.every(c => c.role !== 'sub')).toBe(true);
    expect(selection.subframesSkipped).toBe(0);
  });

  it('a folder that is not an object is recorded with an empty object id, under its own folder name', () => {
    write('_archive/tele-1/CALI_FRAME/cali_001.fits', 'dark');
    const [c] = selectArchiveFiles(DEFAULT_ARCHIVE_CONFIG_ALL).candidates;
    expect(c.objectId).toBe('');
    expect(c.folderName).toBe('_archive');
    expect(c.relPath).toBe('tele-1/CALI_FRAME/cali_001.fits');
    expect(c.archiveRelPath).toBe('_archive/tele-1/CALI_FRAME/cali_001.fits');
  });
});

describe('what is deliberately left out', () => {
  it('a "selected objects" scope archives those objects only, not the top-level folders', () => {
    seedRichLibrary();
    const selection = selectArchiveFiles({ ...DEFAULT_ARCHIVE_CONFIG, scope: 'selected', selectedObjects: ['M31'], includeSubframes: true });
    const folders = new Set(selection.candidates.map(c => c.folderName));
    expect([...folders]).toEqual([M31]);
    // ...but that object's processed images come with it.
    expect(selection.candidates.some(c => c.relPath === 'processed/final.jpg')).toBe(true);
  });

  it('the folder of an object the user deleted is not brought back into the backup', () => {
    seedObject('M31', M31, { deleted: true });
    write(`${M31}/processed/final.jpg`, 'final');
    write('Stray Folder/whatever.jpg', 'stray');
    const folders = selectArchiveFiles(DEFAULT_ARCHIVE_CONFIG_ALL).candidates.map(c => c.folderName);
    expect(folders).toEqual(['Stray Folder']);
  });

  it('a live object is not also swept up as a stray folder (no file appears twice)', () => {
    seedRichLibrary();
    const paths = selectArchiveFiles(DEFAULT_ARCHIVE_CONFIG_ALL).candidates.map(c => c.archiveRelPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('never follows a symlink out of the library', () => {
    seedObject('M31', M31);
    write(`${M31}/${SESSION}/${STACKED_JPG}`, 'real');
    const outside = scratchDir();
    fs.writeFileSync(path.join(outside, 'secret.jpg'), 'outside the library');
    fs.mkdirSync(path.join(outside, 'dir'));
    fs.writeFileSync(path.join(outside, 'dir', 'inner.jpg'), 'inner');
    fs.symlinkSync(path.join(outside, 'secret.jpg'), path.join(getLibraryDir(), M31, 'linked-file.jpg'));
    fs.symlinkSync(path.join(outside, 'dir'), path.join(getLibraryDir(), M31, 'linked-dir'));
    const paths = selectArchiveFiles(DEFAULT_ARCHIVE_CONFIG_ALL).candidates.map(c => c.relPath);
    expect(paths).toEqual([`${SESSION}/${STACKED_JPG}`]);
  });
});

describe('a run copies everything to the disk, byte for byte', () => {
  it('archives processed images, calibration, restacks and stray folders, and records them', async () => {
    seedRichLibrary();
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);

    const result = await runArchive(configFor(dest));
    expect(result.failures).toEqual([]);

    const expected = everythingUnder(getLibraryDir()).filter(p => !p.startsWith('@src/'));
    expect(everythingUnder(dest)).toEqual(expected);
    for (const rel of expected) {
      expect(fs.readFileSync(path.join(dest, rel)), rel).toEqual(fs.readFileSync(path.join(getLibraryDir(), rel)));
    }

    const manifest = readArchiveManifest(dest, ARCHIVE_ID);
    expect(Object.keys(manifest.objects).sort()).toEqual(['M 31', 'M 42', 'RESTACKED', 'Stray Folder', '_archive']);
    expect(manifest.objects._archive.objectId).toBe('');
    expect(manifest.objects[M31].files.map(f => f.relPath)).toContain('processed/final.xisf');
    // Nothing that is not a sub-frame is ever recorded as one.
    expect(manifest.objects._archive.files.every(f => !f.isSubframe)).toBe(true);
    expect(manifest.objects[M31].files.filter(f => f.isSubframe).map(f => f.relPath)).toEqual([`${SESSION}/${SUB_FIT}`]);
  });

  it('a second run over an unchanged library copies nothing', async () => {
    seedRichLibrary();
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    await runArchive(configFor(dest));
    const again = await runArchive(configFor(dest));
    expect(again.failures).toEqual([]);
    expect(again.copied).toBe(0);
    expect(again.skipped).toBeGreaterThan(0);
  });

  it('a changed processed image is copied again, not skipped as "already there"', async () => {
    seedRichLibrary();
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    await runArchive(configFor(dest));
    write(`${M31}/processed/final.jpg`, 'final, re-exported with a different crop');
    const again = await runArchive(configFor(dest));
    expect(again.copied).toBe(1);
    expect(fs.readFileSync(path.join(dest, M31, 'processed', 'final.jpg'), 'utf8')).toBe('final, re-exported with a different crop');
  });

  it('the browser lists the top-level folders and knows which of their files are missing locally', async () => {
    seedRichLibrary();
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    await runArchive(configFor(dest));
    fs.rmSync(path.join(getLibraryDir(), '_archive', 'tele-1', 'CALI_FRAME', 'cali_001.fits'));
    const { objects } = await listArchivedObjects(configFor(dest));
    const cal = objects.find(o => o.folderName === '_archive');
    expect(cal?.filesTotal).toBe(2);
    expect(cal?.missingLocally).toBe(1);
  });
});

describe('restore brings the new kinds of file back', () => {
  async function archived(): Promise<string> {
    seedRichLibrary();
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    await runArchive(configFor(dest));
    return dest;
  }

  it('a processed image deleted from the library returns byte for byte, with no library row invented for it', async () => {
    const dest = await archived();
    const local = path.join(getLibraryDir(), M31, 'processed', 'final.jpg');
    fs.rmSync(local);
    const rowsBefore = getLibraryFilesForObject('M31').length;

    const r = await restoreArchivedFiles(configFor(dest), [{ folderName: M31, relPath: 'processed/final.jpg' }]);
    expect(r.failures).toEqual([]);
    expect(r.restored).toBe(1);
    expect(fs.readFileSync(local, 'utf8')).toBe('final');
    // Processed images are tracked in their own table; a libraryFiles row would make `processed` look like a session.
    expect(getLibraryFilesForObject('M31').length).toBe(rowsBefore);
    expect(getLibraryFilesForObject('M31').some(f => f.relPath.startsWith('processed/'))).toBe(false);
  });

  it('a calibration frame returns to its place in _archive/, and does not clobber an edited one', async () => {
    const dest = await archived();
    const local = path.join(getLibraryDir(), '_archive', 'tele-1', 'CALI_FRAME', 'cali_001.fits');
    fs.rmSync(local);
    const req = [{ folderName: '_archive', relPath: 'tele-1/CALI_FRAME/cali_001.fits' }];

    const r = await restoreArchivedFiles(configFor(dest), req);
    expect(r.failures).toEqual([]);
    expect(fs.readFileSync(local, 'utf8')).toBe('dark');

    fs.writeFileSync(local, 'edited by the user');
    const conflict = await restoreArchivedFiles(configFor(dest), req);
    expect(conflict.conflicts).toHaveLength(1);
    expect(fs.readFileSync(local, 'utf8')).toBe('edited by the user');
    const forced = await restoreArchivedFiles(configFor(dest), req, { overwrite: true });
    expect(forced.restored).toBe(1);
    expect(fs.readFileSync(local, 'utf8')).toBe('dark');
  });

  it('refuses a top-level folder whose manifest path tries to escape it', async () => {
    const dest = await archived();
    const manifest = readArchiveManifest(dest, ARCHIVE_ID);
    manifest.objects._archive.files.push({ relPath: '../M 31/planted.jpg', isSubframe: false });
    writeArchiveManifest(dest, manifest);
    const r = await restoreArchivedFiles(configFor(dest), [{ folderName: '_archive', relPath: '../M 31/planted.jpg' }]);
    expect(r.restored).toBe(0);
    expect(r.failures).toHaveLength(1);
    expect(fs.existsSync(path.join(getLibraryDir(), 'M 31', 'planted.jpg'))).toBe(false);
  });

  it('refuses a folder the manifest never recorded as a top-level folder (no writing to arbitrary names)', async () => {
    const dest = await archived();
    const r = await restoreArchivedFiles(configFor(dest), [{ folderName: 'NotRecorded', relPath: 'x.jpg' }]);
    expect(r.restored).toBe(0);
    expect(r.failures).toHaveLength(1);
  });
});

describe('the destructive steps never touch the new kinds of file', () => {
  it('"remove local sub-frames" leaves processed images and calibration frames alone', async () => {
    seedRichLibrary();
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    const config = configFor(dest, { removeLocalAfter: true });
    await runArchive(config);
    const before = everythingUnder(getLibraryDir());
    const r = await removeVerifiedLocalSubframes(config);
    expect(r.failures).toEqual([]);
    const gone = before.filter(p => !fs.existsSync(path.join(getLibraryDir(), p)));
    for (const p of gone) expect(p, 'only the sub-frame may go').toBe(`${M31}/${SESSION}/${SUB_FIT}`);
    expect(fs.existsSync(path.join(getLibraryDir(), M31, 'processed', 'final.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(getLibraryDir(), '_archive', 'tele-1', 'CALI_FRAME', 'cali_001.fits'))).toBe(true);
  });

  it('sub-frames-only retention never prunes a processed image or a calibration frame, however old', async () => {
    seedRichLibrary();
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    await runArchive(configFor(dest));
    const manifest = readArchiveManifest(dest, ARCHIVE_ID);
    const past = new Date(Date.now() - 400 * 86_400_000).toISOString();
    for (const entry of Object.values(manifest.objects)) { entry.firstArchivedAt = past; entry.lastArchivedAt = past; }
    writeArchiveManifest(dest, manifest);

    const config = configFor(dest, { retentionEnabled: true, retentionDays: 30, retentionSubframesOnly: true });
    const plan = await planArchiveRetention(config, new Date());
    expect(plan.items.flatMap(i => i.files)).toEqual([`${M31}/${SESSION}/${SUB_FIT}`]);
    await applyArchiveRetention(config, plan);
    expect(fs.existsSync(path.join(dest, M31, 'processed', 'final.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(dest, '_archive', 'tele-1', 'CALI_FRAME', 'cali_001.fits'))).toBe(true);
  });

  it('whole-object retention keeps an archived processed image whose local copy is gone: the archive is the only copy', async () => {
    seedRichLibrary();
    const dest = scratchDir();
    writeArchiveMarker(dest, ARCHIVE_ID);
    await runArchive(configFor(dest));
    const manifest = readArchiveManifest(dest, ARCHIVE_ID);
    const past = new Date(Date.now() - 400 * 86_400_000).toISOString();
    for (const entry of Object.values(manifest.objects)) { entry.firstArchivedAt = past; entry.lastArchivedAt = past; }
    writeArchiveManifest(dest, manifest);
    fs.rmSync(path.join(getLibraryDir(), M31, 'processed', 'final.jpg'));
    fs.rmSync(path.join(getLibraryDir(), '_archive', 'tele-1', 'DWARF_DARK', 'dark_001.fits'));

    const config = configFor(dest, { retentionEnabled: true, retentionDays: 30, retentionSubframesOnly: false });
    const plan = await applyPlan(config);
    expect(plan.removedPaths).not.toContain(`${M31}/processed/final.jpg`);
    expect(plan.removedPaths).not.toContain('_archive/tele-1/DWARF_DARK/dark_001.fits');
    expect(fs.existsSync(path.join(dest, M31, 'processed', 'final.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(dest, '_archive', 'tele-1', 'DWARF_DARK', 'dark_001.fits'))).toBe(true);
  });
});

async function applyPlan(config: ArchiveConfig): Promise<{ removedPaths: string[] }> {
  const plan = await planArchiveRetention(config, new Date());
  await applyArchiveRetention(config, plan);
  return { removedPaths: plan.items.flatMap(i => i.files) };
}
