import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import db from '../../server/lib/db';
import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { getLibraryFilesForObject, recordLibraryFiles } from '../../server/lib/library/libraryFiles';
import { writeArchiveMarker } from '../../server/lib/archive/archiveMarker';
import { DEFAULT_ARCHIVE_CONFIG, getArchiveConfig, setArchiveConfig, type ArchiveConfig } from '../../server/lib/archive/archiveConfig';
import { runArchive } from '../../server/lib/archive/archiveCopy';
import { tickArchiveScheduler } from '../../server/lib/archive/archiveScheduler';
import { removeVerifiedLocalSubframes } from '../../server/lib/archive/archiveLocalRemoval';

/**
 * Removing local subframes after they are archived.
 *
 * This is the step the whole copy discipline exists for. Archiving is read-only;
 * this deletes from the user's library, permanently, on the strength of a claim
 * that a copy exists somewhere else. The claim has to be *verified*, not assumed,
 * because the failure mode is the one this codebase has already suffered: the
 * Dwarf RESTACKED migration inferred "already present" from a path relationship
 * and deleted the only copy of the user's data.
 *
 * So the shape is refusal first, again. The local file is left alone when:
 *
 *   - the setting is off (the default),
 *   - the archived copy is missing, truncated, or has different contents,
 *   - the disk is not this install's archive,
 *   - the path is not contained in its own object folder, or
 *   - the thing at the path is no longer a regular file.
 */

const created: string[] = [];
const seededObjectIds: string[] = [];
const STACKED_JPG = 'Stacked_10_M31_10.0s_LP_20241008-220000.jpg';
const STACKED_FIT = 'Stacked_50_M31_10.0s_LP_20241008-220000.fit';
const SUB_FIT_A = 'sub_00001_M31_10.0s_LP_20241008-220000.fit';
const SUB_FIT_B = 'sub_00002_M31_10.0s_LP_20241008-220000.fit';
const M31_FOLDER = 'M 31';
const SESSION = '2024-10-08_22-00-00';
const ARCHIVE_ID = 'archive-under-test';

const CONTENT = {
  stackedJpg: 'stacked-jpg',
  stackedFit: 'stacked-fits',
  subA: 'sub-a',
  subB: 'sub-b',
} as const;

function scratchDir(prefix = 'nebulis-archive-test-localrm-'): string {
  const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), prefix));
  created.push(dir);
  return dir;
}

function seedObject(objectId: string, folderName: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 0, ?, 0)',
  ).run(objectId, folderName, new Date().toISOString());
  seededObjectIds.push(objectId);
  db.prepare("UPDATE libraryObjects SET layout = 'nested' WHERE objectId = ?").run(objectId);
}

function writeLibraryFile(relPath: string, content: string): void {
  const abs = path.join(getLibraryDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const localPath = (relPath: string): string => path.join(getLibraryDir(), M31_FOLDER, relPath);
const archivedPath = (dest: string, relPath: string): string => path.join(dest, M31_FOLDER, relPath);

function configFor(dest: string, overrides: Partial<ArchiveConfig> = {}): ArchiveConfig {
  return {
    ...DEFAULT_ARCHIVE_CONFIG,
    path: dest,
    archiveId: ARCHIVE_ID,
    includeSubframes: true,
    ...overrides,
  };
}

beforeEach(() => {
  seededObjectIds.length = 0;
});

afterEach(() => {
  // The suite shares one appSettings row, so a destination and a last-run stamp
  // must not be left behind for whichever file runs next.
  setArchiveConfig(DEFAULT_ARCHIVE_CONFIG);
  for (const objectId of seededObjectIds.splice(0)) {
    // libraryFiles has no cascade from libraryObjects, and relPath is UNIQUE
    // across the shared database, so both have to go.
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(objectId);
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
  }
  fs.rmSync(getLibraryDir(), { recursive: true, force: true });
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Seed and archive one object, so both sides are exactly what the feature makes. */
async function archiveOneObject(dest: string): Promise<void> {
  writeArchiveMarker(dest, ARCHIVE_ID);
  seedObject('M31', M31_FOLDER);
  writeLibraryFile(`${M31_FOLDER}/${SESSION}/${STACKED_JPG}`, CONTENT.stackedJpg);
  writeLibraryFile(`${M31_FOLDER}/${SESSION}/${STACKED_FIT}`, CONTENT.stackedFit);
  writeLibraryFile(`${M31_FOLDER}/${SESSION}/${SUB_FIT_A}`, CONTENT.subA);
  writeLibraryFile(`${M31_FOLDER}/${SESSION}/${SUB_FIT_B}`, CONTENT.subB);

  // The library's own records, as an import would have written them. Without
  // these the bookkeeping assertions below would be vacuous: there would be no
  // rows to keep consistent in the first place.
  recordLibraryFiles([
    { objectId: 'M31', folderName: M31_FOLDER, sessionFolder: SESSION, fileName: STACKED_JPG, role: 'stacked' },
    { objectId: 'M31', folderName: M31_FOLDER, sessionFolder: SESSION, fileName: STACKED_FIT, role: 'stacked' },
    { objectId: 'M31', folderName: M31_FOLDER, sessionFolder: SESSION, fileName: SUB_FIT_A, role: 'sub' },
    { objectId: 'M31', folderName: M31_FOLDER, sessionFolder: SESSION, fileName: SUB_FIT_B, role: 'sub' },
  ]);

  const result = await runArchive(configFor(dest));
  expect(result.ran).toBe(true);
  expect(result.failures).toEqual([]);
}

describe('removeVerifiedLocalSubframes — refusals', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDir();
    await archiveOneObject(dest);
  });

  it('does nothing when the setting is off, which is the default', async () => {
    const result = await removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: false }));
    expect(result.ran).toBe(false);
    expect(result.removed).toBe(0);
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_A}`))).toBe(true);
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_B}`))).toBe(true);
  });

  it('does not remove a subframe whose archived copy is missing', async () => {
    fs.rmSync(archivedPath(dest, `${SESSION}/${SUB_FIT_A}`));

    const result = await removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: true }));
    // The other subframe is verified and goes; this one must not.
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_A}`))).toBe(true);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it('does not remove a subframe whose archived copy has different contents', async () => {
    // Same length, different bytes: a size check alone would call this verified.
    fs.writeFileSync(archivedPath(dest, `${SESSION}/${SUB_FIT_A}`), 'xxxxx');

    await removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: true }));
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_A}`))).toBe(true);
  });

  it('does not remove a subframe whose archived copy is truncated', async () => {
    fs.writeFileSync(archivedPath(dest, `${SESSION}/${SUB_FIT_B}`), 'su');

    await removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: true }));
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_B}`))).toBe(true);
  });

  it('removes nothing when the disk is not this install\'s archive', async () => {
    const foreign = scratchDir();
    writeArchiveMarker(foreign, 'someone-elses');

    const result = await removeVerifiedLocalSubframes(configFor(foreign, { removeLocalAfter: true }));
    expect(result.ran).toBe(false);
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_A}`))).toBe(true);
  });

  it('leaves a local subframe alone when it is no longer a regular file', async () => {
    const target = localPath(`${SESSION}/${SUB_FIT_A}`);
    const elsewhere = scratchDir();
    const real = path.join(elsewhere, 'real.fit');
    fs.writeFileSync(real, CONTENT.subA);
    fs.rmSync(target);
    fs.symlinkSync(real, target);

    await removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: true }));
    // Removing the link would remove something the record does not describe, and
    // following it would delete outside the library.
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe(CONTENT.subA);
  });
});

describe('removeVerifiedLocalSubframes — what it removes', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDir();
    await archiveOneObject(dest);
  });

  it('removes verified subframes and leaves everything else', async () => {
    const result = await removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: true }));

    expect(result.ran).toBe(true);
    expect(result.removed).toBe(2);
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_A}`))).toBe(false);
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_B}`))).toBe(false);
    // Never the stacks: the setting is about the raw frames, which are the bulk.
    expect(fs.existsSync(localPath(`${SESSION}/${STACKED_JPG}`))).toBe(true);
    expect(fs.existsSync(localPath(`${SESSION}/${STACKED_FIT}`))).toBe(true);
  });

  it('leaves the archived copies in place', async () => {
    await removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: true }));
    expect(fs.readFileSync(archivedPath(dest, `${SESSION}/${SUB_FIT_A}`), 'utf8')).toBe(CONTENT.subA);
    expect(fs.readFileSync(archivedPath(dest, `${SESSION}/${SUB_FIT_B}`), 'utf8')).toBe(CONTENT.subB);
  });

  it('keeps the library records consistent', async () => {
    await removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: true }));

    const rows = getLibraryFilesForObject('M31');
    // No rows for files that are gone, or the library lists phantom files.
    expect(rows.some(r => r.relPath.includes(SUB_FIT_A))).toBe(false);
    expect(rows.some(r => r.relPath.includes(SUB_FIT_B))).toBe(false);
    expect(rows.some(r => r.relPath.includes(STACKED_JPG))).toBe(true);

    const count = db.prepare('SELECT fileCount FROM libraryObjects WHERE objectId = ?').get('M31') as { fileCount: number };
    expect(count.fileCount).toBe(2);
  });

  it('is idempotent: a second call removes nothing', async () => {
    await removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: true }));
    const second = await removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: true }));
    expect(second.removed).toBe(0);
  });

  it('reports what it freed', async () => {
    const result = await removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: true }));
    expect(result.bytesRemoved).toBe(Buffer.byteLength(CONTENT.subA) + Buffer.byteLength(CONTENT.subB));
  });
});

describe('the setting actually reaches the schedule', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDir();
    await archiveOneObject(dest);
  });

  it('a scheduled run removes verified subframes when the setting is on', async () => {
    setArchiveConfig({
      ...configFor(dest, { enabled: true, removeLocalAfter: true, scheduleEnabled: true, scheduleHour: 0 }),
    });
    const outcome = await tickArchiveScheduler(new Date('2026-03-10T12:00:00Z'), 'UTC');

    expect(outcome.ran).toBe(true);
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_A}`))).toBe(false);
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_B}`))).toBe(false);
    // Said out loud in the run result, so the UI can account for the space.
    expect(getArchiveConfig().lastResult).toContain('local subframes removed');
  });

  it('a scheduled run leaves them alone when the setting is off', async () => {
    setArchiveConfig({
      ...configFor(dest, { enabled: true, removeLocalAfter: false, scheduleEnabled: true, scheduleHour: 0 }),
    });
    await tickArchiveScheduler(new Date('2026-03-10T12:00:00Z'), 'UTC');

    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_A}`))).toBe(true);
    expect(getArchiveConfig().lastResult).not.toContain('local subframes removed');
  });
});

/**
 * Each file is verified and deleted in turn.
 *
 * Verifying everything first and deleting afterwards leaves a long gap between
 * "this matched" and "now remove it". Re-stack over a subframe, or pull the archive
 * disk, in that gap and the delete acts on a claim that is no longer true.
 */
describe('removeVerifiedLocalSubframes — verify then delete, one file at a time', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDir();
    await archiveOneObject(dest);
  });

  it('keeps a file that changed after it was verified, and still removes the others', async () => {
    const edited = localPath(`${SESSION}/${SUB_FIT_A}`);
    const result = await removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: true }), {
      afterVerify: abs => {
        if (abs === edited) fs.appendFileSync(abs, 'edited after verification');
      },
    });

    expect(fs.existsSync(edited)).toBe(true);
    expect(fs.readFileSync(edited, 'utf8')).toBe(`${CONTENT.subA}edited after verification`);
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_B}`))).toBe(false);
    expect(result.removed).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('keeps a file whose mtime moved even when its size did not', async () => {
    const touched = localPath(`${SESSION}/${SUB_FIT_A}`);
    const result = await removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: true }), {
      afterVerify: abs => {
        if (abs === touched) fs.utimesSync(abs, new Date(), new Date(Date.now() + 60_000));
      },
    });
    expect(fs.existsSync(touched)).toBe(true);
    expect(result.skipped).toBe(1);
  });

  it('leaves every removed file with a verified copy, and the rest untouched, when interrupted', async () => {
    let calls = 0;
    await expect(
      removeVerifiedLocalSubframes(configFor(dest, { removeLocalAfter: true }), {
        afterVerify: () => {
          calls++;
          if (calls === 2) throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');

    // First subframe: removed, and its archived copy is intact.
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_A}`))).toBe(false);
    expect(fs.readFileSync(archivedPath(dest, `${SESSION}/${SUB_FIT_A}`), 'utf8')).toBe(CONTENT.subA);
    // Second: verified but never deleted.
    expect(fs.existsSync(localPath(`${SESSION}/${SUB_FIT_B}`))).toBe(true);
    // Not a subframe: never a candidate.
    expect(fs.existsSync(localPath(`${SESSION}/${STACKED_FIT}`))).toBe(true);
  });
});
