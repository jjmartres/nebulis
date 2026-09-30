import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import db from '../../server/lib/db';
import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { ARCHIVE_MARKER_FILENAME, writeArchiveMarker } from '../../server/lib/archive/archiveMarker';
import { ARCHIVE_MANIFEST_FILENAME, readArchiveManifest, writeArchiveManifest } from '../../server/lib/archive/archiveManifest';
import { DEFAULT_ARCHIVE_CONFIG, type ArchiveConfig } from '../../server/lib/archive/archiveConfig';
import { runArchive } from '../../server/lib/archive/archiveCopy';
import { applyArchiveRetention, planArchiveRetention } from '../../server/lib/archive/archiveRetention';

/**
 * Retention: the only part of the feature that deletes anything the user did not
 * explicitly ask it to delete in that moment.
 *
 * The contract ranks "retention pointed at the wrong directory" as the feature's
 * highest risk, so the shape of this suite is refusal first. Every property below
 * is about what retention must *not* touch:
 *
 *   - a file the archive did not put there,
 *   - the marker or the manifest,
 *   - anything reached through a symlink out of the root,
 *   - a disk whose marker is not ours,
 *   - anything at all, when the configuration says keep forever, or when the run
 *     is a dry run.
 *
 * The archive state is built by running the real copy engine rather than by hand,
 * so the manifest these tests prune against is the one the feature actually
 * produces.
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

/** The exact contents written below, so byte assertions are derived from the same
 *  strings rather than restated as arithmetic that can drift. */
const CONTENT = {
  stackedJpg: 'stacked-jpg',
  stackedFit: 'stacked-fits',
  subA: 'sub-a',
  subB: 'sub-b',
} as const;
const ARCHIVED_BYTES = Object.values(CONTENT).reduce((total, s) => total + Buffer.byteLength(s), 0);

function scratchDest(prefix = 'nebulis-archive-test-retention-'): string {
  const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), prefix));
  created.push(dir);
  return dir;
}

function seedObject(objectId: string, folderName: string, nested = true): void {
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
  return {
    ...DEFAULT_ARCHIVE_CONFIG,
    path: dest,
    archiveId: ARCHIVE_ID,
    includeSubframes: true,
    ...overrides,
  };
}

/** Backdate an object's archive timestamps, to age it without waiting. */
function backdate(dest: string, folderName: string, days: number): void {
  const manifest = readArchiveManifest(dest);
  const entry = manifest.objects[folderName];
  const past = new Date(Date.now() - days * 86_400_000).toISOString();
  manifest.objects[folderName] = { ...entry, firstArchivedAt: past, lastArchivedAt: past };
  writeArchiveManifest(dest, manifest);
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

/** Seed a library of one nested object and archive it, so the archive and its
 *  manifest are exactly what the feature produces. */
async function archiveOneObject(dest: string, opts: { includeSubframes?: boolean } = {}): Promise<void> {
  writeArchiveMarker(dest, ARCHIVE_ID);
  seedObject('M31', M31_FOLDER);
  writeLibraryFile(`${M31_FOLDER}/${SESSION}/${STACKED_JPG}`, CONTENT.stackedJpg);
  writeLibraryFile(`${M31_FOLDER}/${SESSION}/${STACKED_FIT}`, CONTENT.stackedFit);
  writeLibraryFile(`${M31_FOLDER}/${SESSION}/${SUB_FIT_A}`, CONTENT.subA);
  writeLibraryFile(`${M31_FOLDER}/${SESSION}/${SUB_FIT_B}`, CONTENT.subB);
  const result = await runArchive(configFor(dest, { includeSubframes: opts.includeSubframes ?? true }));
  expect(result.ran).toBe(true);
}

describe('planArchiveRetention — when it plans nothing', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDest();
    await archiveOneObject(dest);
  });

  it('plans nothing when the retention period is 0, which means keep forever', async () => {
    const plan = await planArchiveRetention(configFor(dest, { retentionDays: 0 }), new Date());
    expect(plan.items).toEqual([]);
    expect(plan.filesTotal).toBe(0);
  });

  it('plans nothing when the object is younger than the period', async () => {
    backdate(dest, M31_FOLDER, 5);
    const plan = await planArchiveRetention(configFor(dest, { retentionDays: 30 }), new Date());
    expect(plan.items).toEqual([]);
  });

  it('ages from the most recent archive, not the first', async () => {
    // An object that has been in the archive for a year but was topped up
    // yesterday must not be pruned out from under an active project.
    const manifest = readArchiveManifest(dest);
    manifest.objects[M31_FOLDER] = {
      ...manifest.objects[M31_FOLDER],
      firstArchivedAt: new Date(Date.now() - 365 * 86_400_000).toISOString(),
      lastArchivedAt: new Date(Date.now() - 1 * 86_400_000).toISOString(),
    };
    writeArchiveManifest(dest, manifest);

    const plan = await planArchiveRetention(configFor(dest, { retentionDays: 30 }), new Date());
    expect(plan.items).toEqual([]);
  });

  it('plans nothing when the destination has no marker', async () => {
    const empty = scratchDest();
    const plan = await planArchiveRetention(configFor(empty, { retentionDays: 1 }), new Date());
    expect(plan.items).toEqual([]);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it('plans nothing when the disk belongs to another archive', async () => {
    const foreign = scratchDest();
    writeArchiveMarker(foreign, 'someone-elses');
    fs.writeFileSync(path.join(foreign, 'their-file.jpg'), 'theirs');

    const plan = await planArchiveRetention(configFor(foreign, { retentionDays: 1 }), new Date());
    expect(plan.items).toEqual([]);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it('plans nothing when the manifest is unreadable, because then nothing is known to be ours', async () => {
    backdate(dest, M31_FOLDER, 400);
    fs.writeFileSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME), 'corrupt', 'utf8');

    const plan = await planArchiveRetention(configFor(dest, { retentionDays: 30 }), new Date());
    expect(plan.items).toEqual([]);
  });
});

describe('planArchiveRetention — what it plans', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDest();
    await archiveOneObject(dest);
    backdate(dest, M31_FOLDER, 400);
  });

  it('plans every recorded file of an aged object, in whole-object mode', async () => {
    const plan = await planArchiveRetention(configFor(dest, { retentionDays: 30 }), new Date());
    expect(plan.mode).toBe('whole-object');
    expect(plan.filesTotal).toBe(4);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].folderName).toBe(M31_FOLDER);
  });

  it('plans only the subframes in subframes-only mode', async () => {
    const plan = await planArchiveRetention(
      configFor(dest, { retentionDays: 30, retentionSubframesOnly: true }),
      new Date(),
    );
    expect(plan.mode).toBe('subframes-only');
    expect(plan.filesTotal).toBe(2);
    expect(plan.items[0].files.every(f => f.endsWith(SUB_FIT_A) || f.endsWith(SUB_FIT_B))).toBe(true);
  });

  it('counts the bytes it would free', async () => {
    const plan = await planArchiveRetention(configFor(dest, { retentionDays: 30 }), new Date());
    expect(plan.bytesTotal).toBe(ARCHIVED_BYTES);
  });

  it('ignores files the manifest does not name', async () => {
    fs.writeFileSync(path.join(dest, M31_FOLDER, SESSION, 'user-notes.txt'), 'mine');
    const plan = await planArchiveRetention(configFor(dest, { retentionDays: 30 }), new Date());
    expect(plan.filesTotal).toBe(4);
    expect(plan.items[0].files.some(f => f.endsWith('user-notes.txt'))).toBe(false);
  });
});

/** Every file on the archive disk with its contents, so "nothing changed" can be a
 *  comparison rather than a spot check. */
function snapshotArchive(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else out[rel] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(root, '');
  return out;
}

describe('applyArchiveRetention — the dry run removes nothing', () => {
  it('leaves every file, the marker, and the manifest exactly as they were', async () => {
    const dest = scratchDest();
    await archiveOneObject(dest);
    backdate(dest, M31_FOLDER, 400);

    const before = snapshotArchive(dest);
    const plan = await planArchiveRetention(configFor(dest, { retentionDays: 30 }), new Date());

    // Two assertions, and both are doing work. The first is what makes the second
    // meaningful: a plan that wanted to remove nothing would satisfy "nothing was
    // removed" just as well, so this test would prove nothing about the dry run
    // without it. The second is the dry run itself.
    expect(plan.filesTotal).toBeGreaterThan(0);
    expect(snapshotArchive(dest)).toEqual(before);
  });
});

describe('applyArchiveRetention — removing', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDest();
    await archiveOneObject(dest);
    backdate(dest, M31_FOLDER, 400);
  });

  it('removes the recorded files and reports what it freed', async () => {
    const config = configFor(dest, { retentionDays: 30 });
    const plan = await planArchiveRetention(config, new Date());
    const result = await applyArchiveRetention(config, plan);

    expect(result.removed).toBe(4);
    expect(result.bytesRemoved).toBe(ARCHIVED_BYTES);
    expect(result.failures).toEqual([]);
    expect(fs.existsSync(path.join(dest, M31_FOLDER, SESSION, STACKED_JPG))).toBe(false);
  });

  it('never removes the marker or the manifest', async () => {
    const config = configFor(dest, { retentionDays: 30 });
    await applyArchiveRetention(config, await planArchiveRetention(config, new Date()));
    expect(fs.existsSync(path.join(dest, ARCHIVE_MARKER_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME))).toBe(true);
  });

  it('never removes a file the manifest did not name', async () => {
    const stray = path.join(dest, M31_FOLDER, SESSION, 'user-notes.txt');
    fs.writeFileSync(stray, 'mine');

    const config = configFor(dest, { retentionDays: 30 });
    await applyArchiveRetention(config, await planArchiveRetention(config, new Date()));

    // The user put this here. Retention is not entitled to it, whatever its age.
    expect(fs.existsSync(stray)).toBe(true);
    expect(fs.readFileSync(stray, 'utf8')).toBe('mine');
  });

  it('keeps the stacked files in subframes-only mode', async () => {
    const config = configFor(dest, { retentionDays: 30, retentionSubframesOnly: true });
    const result = await applyArchiveRetention(config, await planArchiveRetention(config, new Date()));

    expect(result.removed).toBe(2);
    expect(fs.existsSync(path.join(dest, M31_FOLDER, SESSION, STACKED_JPG))).toBe(true);
    expect(fs.existsSync(path.join(dest, M31_FOLDER, SESSION, SUB_FIT_A))).toBe(false);
  });

  it('reports a recorded path that is now a symlink instead of planning to delete it', async () => {
    const outside = scratchDest();
    const secret = path.join(outside, 'precious.jpg');
    fs.writeFileSync(secret, 'not ours');

    const recorded = path.join(dest, M31_FOLDER, SESSION, STACKED_JPG);
    fs.rmSync(recorded);
    fs.symlinkSync(secret, recorded);

    const config = configFor(dest, { retentionDays: 30 });
    const plan = await planArchiveRetention(config, new Date());
    // The dry run says so rather than quietly planning a delete through it.
    expect(plan.filesTotal).toBe(3);
    expect(plan.warnings.join(' ')).toContain(STACKED_JPG);

    const result = await applyArchiveRetention(config, plan);
    expect(result.removed).toBe(3);
    expect(fs.existsSync(secret)).toBe(true);
    expect(fs.readFileSync(secret, 'utf8')).toBe('not ours');
  });

  it('refuses a symlink handed to it in a plan, so a stale plan cannot delete through one', async () => {
    const outside = scratchDest();
    const secret = path.join(outside, 'precious.jpg');
    fs.writeFileSync(secret, 'not ours');

    const recorded = path.join(dest, M31_FOLDER, SESSION, STACKED_JPG);
    fs.rmSync(recorded);
    fs.symlinkSync(secret, recorded);

    // Hand-built, the way a stale or edited plan would arrive. The planner would
    // never produce this, which is exactly why apply has to check for itself.
    const handMade = {
      mode: 'whole-object' as const,
      root: dest,
      items: [
        {
          folderName: M31_FOLDER,
          archivedAt: new Date().toISOString(),
          files: [`${M31_FOLDER}/${SESSION}/${STACKED_JPG}`],
          bytes: 1,
        },
      ],
      filesTotal: 1,
      bytesTotal: 1,
      warnings: [],
    };

    const config = configFor(dest, { retentionDays: 30 });
    const result = await applyArchiveRetention(config, handMade);

    expect(result.removed).toBe(0);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(fs.readFileSync(secret, 'utf8')).toBe('not ours');
    // The link itself stays: removing it would be removing something the record
    // does not describe.
    expect(fs.lstatSync(recorded).isSymbolicLink()).toBe(true);
  });

  it('removes directories that became empty, and never the archive root', async () => {
    const config = configFor(dest, { retentionDays: 30 });
    await applyArchiveRetention(config, await planArchiveRetention(config, new Date()));

    expect(fs.existsSync(path.join(dest, M31_FOLDER, SESSION))).toBe(false);
    expect(fs.existsSync(path.join(dest, M31_FOLDER))).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('keeps a directory that still holds something', async () => {
    fs.writeFileSync(path.join(dest, M31_FOLDER, SESSION, 'user-notes.txt'), 'mine');
    const config = configFor(dest, { retentionDays: 30 });
    await applyArchiveRetention(config, await planArchiveRetention(config, new Date()));
    expect(fs.existsSync(path.join(dest, M31_FOLDER, SESSION))).toBe(true);
  });

  it('re-checks the marker, so a plan cannot be applied to a disk that changed', async () => {
    const config = configFor(dest, { retentionDays: 30 });
    const plan = await planArchiveRetention(config, new Date());

    // The disk this plan was built for is gone; a different one is mounted.
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    writeArchiveMarker(dest, 'someone-elses');
    fs.writeFileSync(path.join(dest, 'their-file.jpg'), 'theirs');

    const result = await applyArchiveRetention(config, plan);
    expect(result.removed).toBe(0);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(dest, 'their-file.jpg'), 'utf8')).toBe('theirs');
  });

  it('skips a recorded file that is already gone, without failing', async () => {
    fs.rmSync(path.join(dest, M31_FOLDER, SESSION, SUB_FIT_A));
    const config = configFor(dest, { retentionDays: 30 });
    const result = await applyArchiveRetention(config, await planArchiveRetention(config, new Date()));
    expect(result.removed).toBe(3);
    expect(result.failures).toEqual([]);
  });
});

describe('applyArchiveRetention — the record afterwards', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDest();
    await archiveOneObject(dest);
    backdate(dest, M31_FOLDER, 400);
  });

  it('drops a pruned object from the manifest', async () => {
    const config = configFor(dest, { retentionDays: 30 });
    await applyArchiveRetention(config, await planArchiveRetention(config, new Date()));
    expect(readArchiveManifest(dest).objects[M31_FOLDER]).toBeUndefined();
  });

  it('keeps the object but drops the pruned subframes in subframes-only mode', async () => {
    const config = configFor(dest, { retentionDays: 30, retentionSubframesOnly: true });
    await applyArchiveRetention(config, await planArchiveRetention(config, new Date()));

    const entry = readArchiveManifest(dest).objects[M31_FOLDER];
    expect(entry).toBeDefined();
    expect(entry.files.map(f => f.relPath)).toEqual([`${SESSION}/${STACKED_FIT}`, `${SESSION}/${STACKED_JPG}`].sort());
  });

  it('does not prune the same files twice', async () => {
    const config = configFor(dest, { retentionDays: 30 });
    await applyArchiveRetention(config, await planArchiveRetention(config, new Date()));

    const second = await planArchiveRetention(config, new Date());
    expect(second.filesTotal).toBe(0);
  });
});

/**
 * Retention may only prune an archived file that a local file duplicates.
 *
 * The manifest says what the archive holds, not whether the archive is the last
 * copy. An object deleted from the library, or subframes removed locally after
 * archiving, leave the archive as the only copy, and pruning it is deleting the
 * user's data rather than tidying a backup.
 */
describe('retention keeps the only copy', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDest();
    await archiveOneObject(dest);
    backdate(dest, M31_FOLDER, 400);
  });

  const removeLocalObject = (): void => {
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run('M31');
    fs.rmSync(path.join(getLibraryDir(), M31_FOLDER), { recursive: true, force: true });
  };

  it('plans nothing for an object that is gone from the library, and says why', async () => {
    removeLocalObject();
    const plan = await planArchiveRetention(configFor(dest, { retentionDays: 30 }), new Date());
    expect(plan.items).toEqual([]);
    expect(plan.filesTotal).toBe(0);
    expect(plan.warnings.join(' ')).toMatch(/only copy/);
  });

  it('plans nothing for subframes that were removed locally', async () => {
    fs.rmSync(path.join(getLibraryDir(), M31_FOLDER, SESSION, SUB_FIT_A));
    fs.rmSync(path.join(getLibraryDir(), M31_FOLDER, SESSION, SUB_FIT_B));
    const plan = await planArchiveRetention(
      configFor(dest, { retentionDays: 30, retentionSubframesOnly: true }),
      new Date(),
    );
    expect(plan.items).toEqual([]);
  });

  it('still plans the files that do have a local copy', async () => {
    fs.rmSync(path.join(getLibraryDir(), M31_FOLDER, SESSION, SUB_FIT_A));
    const plan = await planArchiveRetention(configFor(dest, { retentionDays: 30 }), new Date());
    expect(plan.filesTotal).toBe(3);
    expect(plan.items[0].files.some(f => f.endsWith(SUB_FIT_A))).toBe(false);
  });

  it('does not treat a different object under the same folder name as the archived one', async () => {
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run('M31');
    seedObject('OTHER', M31_FOLDER);
    const plan = await planArchiveRetention(configFor(dest, { retentionDays: 30 }), new Date());
    expect(plan.items).toEqual([]);
  });

  it('re-checks at apply time, because a plan can be stale', async () => {
    const config = configFor(dest, { retentionDays: 30 });
    const plan = await planArchiveRetention(config, new Date());
    expect(plan.filesTotal).toBe(4);

    // The user deletes the object between the plan being shown and being applied.
    removeLocalObject();
    const result = await applyArchiveRetention(config, plan);

    expect(result.removed).toBe(0);
    expect(fs.existsSync(path.join(dest, M31_FOLDER, SESSION, STACKED_JPG))).toBe(true);
    expect(fs.existsSync(path.join(dest, M31_FOLDER, SESSION, SUB_FIT_A))).toBe(true);
    expect(result.failures.length).toBe(4);
  });

  it('applies to the files that still have a local copy and keeps the rest', async () => {
    const config = configFor(dest, { retentionDays: 30 });
    const plan = await planArchiveRetention(config, new Date());
    fs.rmSync(path.join(getLibraryDir(), M31_FOLDER, SESSION, SUB_FIT_A));
    const result = await applyArchiveRetention(config, plan);

    expect(result.removed).toBe(3);
    expect(fs.existsSync(path.join(dest, M31_FOLDER, SESSION, SUB_FIT_A))).toBe(true);
    expect(fs.existsSync(path.join(dest, M31_FOLDER, SESSION, SUB_FIT_B))).toBe(false);
  });

  it('leaves an unreadable manifest untouched instead of writing an empty one over it', async () => {
    const config = configFor(dest, { retentionDays: 30 });
    const plan = await planArchiveRetention(config, new Date());
    fs.writeFileSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME), 'corrupt', 'utf8');
    // No rolling backup either, so there is nothing to recover from.
    fs.rmSync(path.join(dest, `${ARCHIVE_MANIFEST_FILENAME}.bak`), { force: true });

    const result = await applyArchiveRetention(config, plan);
    expect(fs.readFileSync(path.join(dest, ARCHIVE_MANIFEST_FILENAME), 'utf8')).toBe('corrupt');
    expect(result.failures.join(' ')).toMatch(/manifest/);
  });
});

describe('applyArchiveRetention — a local file must actually duplicate the archived one', () => {
  let dest: string;

  beforeEach(async () => {
    dest = scratchDest();
    await archiveOneObject(dest);
    backdate(dest, M31_FOLDER, 400);
  });

  it('keeps an archived file whose local counterpart was changed since archiving', async () => {
    const config = configFor(dest, { retentionDays: 30, retentionEnabled: true });
    const plan = await planArchiveRetention(config, new Date());
    // Same length, different bytes: a damaged or re-processed local file that a
    // presence-only check would still call "a copy".
    writeLibraryFile(`${M31_FOLDER}/${SESSION}/${STACKED_JPG}`, 'XXXXXXXXXXX');
    expect(Buffer.byteLength('XXXXXXXXXXX')).toBe(Buffer.byteLength(CONTENT.stackedJpg));

    const result = await applyArchiveRetention(config, plan);

    expect(fs.existsSync(path.join(dest, M31_FOLDER, SESSION, STACKED_JPG))).toBe(true);
    expect(fs.readFileSync(path.join(dest, M31_FOLDER, SESSION, STACKED_JPG), 'utf8')).toBe(CONTENT.stackedJpg);
    expect(result.failures.some(f => f.includes(STACKED_JPG))).toBe(true);
    // The three untouched duplicates are still pruned.
    expect(result.removed).toBe(3);
  });

  it('refuses a plan naming a file the archive record does not', async () => {
    const config = configFor(dest, { retentionDays: 30, retentionEnabled: true });
    const plan = await planArchiveRetention(config, new Date());
    // A user's own file next to the archived ones, with a same-named local file.
    fs.writeFileSync(path.join(dest, M31_FOLDER, SESSION, 'mine.jpg'), 'user file');
    writeLibraryFile(`${M31_FOLDER}/${SESSION}/mine.jpg`, 'user file');
    plan.items[0].files.push(`${M31_FOLDER}/${SESSION}/mine.jpg`);

    await applyArchiveRetention(config, plan);

    expect(fs.existsSync(path.join(dest, M31_FOLDER, SESSION, 'mine.jpg'))).toBe(true);
  });
});
