import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import db from '../../server/lib/db';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { setObjectLayout } from '../../server/lib/library/libraryLayout';
import { roleForFile } from '../../server/lib/library/libraryFiles';
import { selectArchiveFiles } from '../../server/lib/archive/archiveSelect';
import { DEFAULT_ARCHIVE_CONFIG, type ArchiveConfig } from '../../server/lib/archive/archiveConfig';

/**
 * What gets archived.
 *
 * The selection walks each object folder in full and uses the library's own role
 * classifier (`resolverFor(...).role`) rather than re-deriving "is this a
 * subframe" from filenames here. Two definitions of that would eventually
 * disagree, and the disagreement would show up as subframes silently surviving a
 * "don't archive subframes" setting, or worse, as a local-removal pass deleting
 * something it had not archived.
 *
 * The file counts are asserted rather than "some files were selected", because a
 * filter that drops everything satisfies a loose assertion.
 */

const STACKED_JPG = 'Stacked_10_M31_10.0s_LP_20241008-220000.jpg';
const STACKED_FIT = 'Stacked_50_M31_10.0s_LP_20241008-220000.fit';
const SUB_FIT_A = 'sub_00001_M31_10.0s_LP_20241008-220000.fit';
const SUB_FIT_B = 'sub_00002_M31_10.0s_LP_20241008-220000.fit';
const THUMB_JPG = 'Stacked_10_M31_10.0s_LP_20241008-220000_thn.jpg';

const M31_FOLDER = 'M 31';
const M31_SESSION = '2024-10-08_22-00-00';
const M42_FOLDER = 'M 42';

const seededObjectIds: string[] = [];

function seedObject(objectId: string, folderName: string, opts: { nested?: boolean; deleted?: boolean } = {}): void {
  db.prepare(
    'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 0, ?, ?)',
  ).run(objectId, folderName, new Date().toISOString(), opts.deleted ? 1 : 0);
  seededObjectIds.push(objectId);
  if (opts.nested) setObjectLayout(objectId, 'nested');
}

function writeFile(relPath: string, content: string): number {
  const abs = path.join(getLibraryDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return Buffer.byteLength(content);
}

function configWith(overrides: Partial<ArchiveConfig> = {}): ArchiveConfig {
  return { ...DEFAULT_ARCHIVE_CONFIG, ...overrides };
}

beforeEach(() => {
  seededObjectIds.length = 0;
});

afterEach(() => {
  for (const objectId of seededObjectIds.splice(0)) {
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
  }
  fs.rmSync(getLibraryDir(), { recursive: true, force: true });
});

describe('fixture premise: the roles this suite relies on', () => {
  it('classifies the seeded filenames the way the tests assume', () => {
    // If the library's classifier changes, these tests would otherwise keep
    // passing or failing for a reason that is not about archiving at all.
    // Note `Stacked_...jpg` is 'stacked', not 'preview': roleForFile checks the
    // parsed type before the image extension, so a JPEG can be a stack.
    expect(roleForFile(STACKED_JPG)).toBe('stacked');
    expect(roleForFile(STACKED_FIT)).toBe('stacked');
    expect(roleForFile(SUB_FIT_A)).toBe('sub');
    expect(roleForFile(THUMB_JPG)).toBe('thumbnail');
  });
});

describe('selectArchiveFiles — scope', () => {
  it('selects every real file of a flat object', () => {
    seedObject('M31', M31_FOLDER);
    const a = writeFile(`${M31_FOLDER}/${STACKED_JPG}`, 'aaa');
    const b = writeFile(`${M31_FOLDER}/${STACKED_FIT}`, 'bbbb');
    const c = writeFile(`${M31_FOLDER}/${SUB_FIT_A}`, 'ccccc');

    const selection = selectArchiveFiles(configWith({ scope: 'all', includeSubframes: true }));
    expect(selection.candidates).toHaveLength(3);
    expect(selection.bytesTotal).toBe(a + b + c);
    expect(selection.objectsConsidered).toBe(1);
    expect(selection.subframesSkipped).toBe(0);
  });

  it('drops subframes when they are excluded, and counts what it dropped', () => {
    seedObject('M31', M31_FOLDER);
    const a = writeFile(`${M31_FOLDER}/${STACKED_JPG}`, 'aaa');
    const b = writeFile(`${M31_FOLDER}/${STACKED_FIT}`, 'bbbb');
    writeFile(`${M31_FOLDER}/${SUB_FIT_A}`, 'ccccc');
    writeFile(`${M31_FOLDER}/${SUB_FIT_B}`, 'dddddd');

    const selection = selectArchiveFiles(configWith({ scope: 'all', includeSubframes: false }));
    expect(selection.candidates).toHaveLength(2);
    expect(selection.bytesTotal).toBe(a + b);
    // Counted rather than merely dropped, so the UI can say what is being left
    // behind instead of the number quietly differing from the library's total.
    expect(selection.subframesSkipped).toBe(2);
  });

  it('selects only the named objects when the scope is a subset', () => {
    seedObject('M31', M31_FOLDER);
    seedObject('M42', M42_FOLDER);
    writeFile(`${M31_FOLDER}/${STACKED_JPG}`, 'aaa');
    writeFile(`${M42_FOLDER}/${STACKED_JPG}`, 'bbb');

    const selection = selectArchiveFiles(
      configWith({ scope: 'selected', selectedObjects: ['M31'], includeSubframes: true }),
    );
    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0].objectId).toBe('M31');
    expect(selection.objectsConsidered).toBe(1);
  });

  it('returns nothing, without throwing, when the subset names no known object', () => {
    seedObject('M31', M31_FOLDER);
    writeFile(`${M31_FOLDER}/${STACKED_JPG}`, 'aaa');

    const selection = selectArchiveFiles(
      configWith({ scope: 'selected', selectedObjects: ['NGC-does-not-exist'], includeSubframes: true }),
    );
    expect(selection.candidates).toEqual([]);
    expect(selection.bytesTotal).toBe(0);
  });

  it('ignores objects marked deleted', () => {
    seedObject('M31', M31_FOLDER, { deleted: true });
    writeFile(`${M31_FOLDER}/${STACKED_JPG}`, 'aaa');

    const selection = selectArchiveFiles(configWith({ scope: 'all', includeSubframes: true }));
    expect(selection.candidates).toEqual([]);
  });
});

describe('selectArchiveFiles — paths', () => {
  it('mirrors the library folder layout, so the disk is usable directly', () => {
    seedObject('M31', M31_FOLDER);
    writeFile(`${M31_FOLDER}/${STACKED_JPG}`, 'aaa');

    const [candidate] = selectArchiveFiles(configWith({ includeSubframes: true })).candidates;
    // Decision 7: the object folder name, then the file. Nothing is flattened,
    // because a disk the user can point Siril at is the point of the feature.
    expect(candidate.archiveRelPath).toBe(`${M31_FOLDER}/${STACKED_JPG}`);
    expect(candidate.relPath).toBe(STACKED_JPG);
    expect(candidate.sourcePath).toBe(path.join(getLibraryDir(), M31_FOLDER, STACKED_JPG));
  });

  it('keeps the session folder for a nested object', () => {
    seedObject('M31', M31_FOLDER, { nested: true });
    writeFile(`${M31_FOLDER}/${M31_SESSION}/${STACKED_JPG}`, 'aaa');
    writeFile(`${M31_FOLDER}/${M31_SESSION}/${SUB_FIT_A}`, 'bbbb');

    const selection = selectArchiveFiles(configWith({ includeSubframes: true }));
    expect(selection.candidates).toHaveLength(2);
    for (const candidate of selection.candidates) {
      expect(candidate.archiveRelPath).toBe(`${M31_FOLDER}/${M31_SESSION}/${candidate.fileName}`);
      expect(candidate.sessionFolder).toBe(M31_SESSION);
    }
  });

  it('skips the manifest and OS junk, but keeps every other file whatever its extension', () => {
    seedObject('M31', M31_FOLDER);
    const real = writeFile(`${M31_FOLDER}/${STACKED_JPG}`, 'aaa');
    writeFile(`${M31_FOLDER}/.nebulis-files.json`, '{}');
    writeFile(`${M31_FOLDER}/.DS_Store`, 'x');
    writeFile(`${M31_FOLDER}/Thumbs.db`, 'x');
    // A user's own file is not bookkeeping: the archive is a backup of everything in the library folder.
    const notes = writeFile(`${M31_FOLDER}/notes.txt`, 'hello');

    const selection = selectArchiveFiles(configWith({ includeSubframes: true }));
    expect(selection.candidates.map(c => c.fileName).sort()).toEqual(['notes.txt', STACKED_JPG].sort());
    expect(selection.bytesTotal).toBe(real + notes);
  });

  it('reports a warning and continues when an object folder is missing', () => {
    seedObject('M31', M31_FOLDER);
    seedObject('M42', 'M 42-missing');
    writeFile(`${M31_FOLDER}/${STACKED_JPG}`, 'aaa');

    const selection = selectArchiveFiles(configWith({ includeSubframes: true }));
    expect(selection.candidates).toHaveLength(1);
    // One unreadable object must not abandon the whole run: the user would
    // rather archive eleven objects than none.
    expect(selection.warnings.length).toBeGreaterThan(0);
  });
});

describe('selectArchiveFiles — a file count that reflects the library', () => {
  it('sums bytes across objects', () => {
    seedObject('M31', M31_FOLDER);
    seedObject('M42', M42_FOLDER);
    const a = writeFile(`${M31_FOLDER}/${STACKED_JPG}`, 'aaa');
    const b = writeFile(`${M42_FOLDER}/${STACKED_FIT}`, 'bbbb');

    const selection = selectArchiveFiles(configWith({ includeSubframes: true }));
    expect(selection.candidates).toHaveLength(2);
    expect(selection.bytesTotal).toBe(a + b);
    expect(selection.objectsConsidered).toBe(2);
  });
});

describe('selectArchiveFiles — minimum age', () => {
  const NOW = new Date('2024-11-07T00:00:00.000Z');

  it('copies everything when the filter is off, regardless of age', () => {
    seedObject('M31', M31_FOLDER, { nested: true });
    // The session folder (2024-10-08) is a month before NOW, which would be
    // excluded by any reasonable minimum, but the filter is off.
    writeFile(`${M31_FOLDER}/${M31_SESSION}/${STACKED_JPG}`, 'aaa');

    const selection = selectArchiveFiles(
      configWith({ includeSubframes: true, copyMinAgeEnabled: false, copyMinAgeDays: 90 }),
      NOW,
    );
    expect(selection.candidates).toHaveLength(1);
    expect(selection.tooYoungSkipped).toBe(0);
  });

  it('excludes a file whose session is younger than the minimum, and counts it', () => {
    seedObject('M31', M31_FOLDER, { nested: true });
    // 2024-10-08 is 30 days before NOW (2024-11-07); a 45-day minimum excludes it.
    writeFile(`${M31_FOLDER}/${M31_SESSION}/${STACKED_JPG}`, 'aaa');

    const selection = selectArchiveFiles(
      configWith({ includeSubframes: true, copyMinAgeEnabled: true, copyMinAgeDays: 45 }),
      NOW,
    );
    expect(selection.candidates).toEqual([]);
    expect(selection.tooYoungSkipped).toBe(1);
  });

  it('includes a file whose session has reached the minimum age', () => {
    seedObject('M31', M31_FOLDER, { nested: true });
    // Same 30-day-old session, but a 20-day minimum is already satisfied.
    writeFile(`${M31_FOLDER}/${M31_SESSION}/${STACKED_JPG}`, 'aaa');

    const selection = selectArchiveFiles(
      configWith({ includeSubframes: true, copyMinAgeEnabled: true, copyMinAgeDays: 20 }),
      NOW,
    );
    expect(selection.candidates).toHaveLength(1);
    expect(selection.tooYoungSkipped).toBe(0);
  });

  it('reads the date out of the filename when there is no session folder', () => {
    // Flat object: no session folder, so the filter falls through to the
    // filename's own timestamp (2024-10-08 in STACKED_JPG).
    seedObject('M31', M31_FOLDER);
    writeFile(`${M31_FOLDER}/${STACKED_JPG}`, 'aaa');

    const tooRecent = selectArchiveFiles(
      configWith({ includeSubframes: true, copyMinAgeEnabled: true, copyMinAgeDays: 45 }),
      NOW,
    );
    expect(tooRecent.candidates).toEqual([]);
    expect(tooRecent.tooYoungSkipped).toBe(1);

    const oldEnough = selectArchiveFiles(
      configWith({ includeSubframes: true, copyMinAgeEnabled: true, copyMinAgeDays: 20 }),
      NOW,
    );
    expect(oldEnough.candidates).toHaveLength(1);
  });

  it('falls back to the file mtime when neither the session folder nor the filename carries a date', () => {
    seedObject('M31', M31_FOLDER, { nested: true });
    // A Dwarf-style session folder name carries no date at all.
    const relPath = `${M31_FOLDER}/DWARF_SESSION/notes.fit`;
    writeFile(relPath, 'aaa');
    const abs = path.join(getLibraryDir(), relPath);
    const oldMtime = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days old
    fs.utimesSync(abs, oldMtime, oldMtime);

    const tooRecent = selectArchiveFiles(
      configWith({ includeSubframes: true, copyMinAgeEnabled: true, copyMinAgeDays: 90 }),
      NOW,
    );
    expect(tooRecent.tooYoungSkipped).toBe(1);

    const oldEnough = selectArchiveFiles(
      configWith({ includeSubframes: true, copyMinAgeEnabled: true, copyMinAgeDays: 45 }),
      NOW,
    );
    expect(oldEnough.candidates).toHaveLength(1);
  });
});

describe('selectArchiveFiles — linked files', () => {
  const linkFile = (objectId: string, name: string, missing = false): void => {
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, bytes, sourceId, sourcePath, missingSince, importedAt)
       VALUES (?, ?, ?, ?, 'stacked', 10, 'src_test', ?, ?, ?)`,
    ).run(objectId, `@src/src_test/${objectId}/${name}`, name, name, `${objectId}/${name}`, missing ? new Date().toISOString() : null, new Date().toISOString());
  };

  afterEach(() => {
    db.prepare("DELETE FROM libraryFiles WHERE sourceId = 'src_test'").run();
  });

  it('counts linked files as left out, and does not call an all-linked object a missing folder', () => {
    seedObject('M31', M31_FOLDER); // no folder on disk: every file of this object is linked
    linkFile('M31', 'a.jpg');
    linkFile('M31', 'b.jpg');

    const selection = selectArchiveFiles(configWith({ scope: 'all' }));
    expect(selection.linkedSkipped).toBe(2);
    expect(selection.candidates).toEqual([]);
    expect(selection.warnings).toEqual([]);
  });

  it('still warns about a missing folder when the object has no linked files', () => {
    seedObject('M31', M31_FOLDER);
    const selection = selectArchiveFiles(configWith({ scope: 'all' }));
    expect(selection.linkedSkipped).toBe(0);
    expect(selection.warnings).toHaveLength(1);
  });

  it('archives the managed files of a mixed object and counts only its linked ones', () => {
    seedObject('M31', M31_FOLDER);
    writeFile(`${M31_FOLDER}/${STACKED_JPG}`, 'aaa');
    linkFile('M31', 'a.jpg');
    linkFile('M31', 'gone.jpg', true); // flagged missing: not counted

    const selection = selectArchiveFiles(configWith({ scope: 'all' }));
    expect(selection.candidates).toHaveLength(1);
    expect(selection.linkedSkipped).toBe(1);
  });

  it('counts only the selected objects under a subset scope', () => {
    seedObject('M31', M31_FOLDER);
    seedObject('M42', M42_FOLDER);
    linkFile('M31', 'a.jpg');
    linkFile('M42', 'b.jpg');

    const selection = selectArchiveFiles(configWith({ scope: 'selected', selectedObjects: ['M31'] }));
    expect(selection.linkedSkipped).toBe(1);
  });
});
