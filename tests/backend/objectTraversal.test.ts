import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Uses the shared test DATA_DIR from vitest.config.ts (like telescopeFiles.test.ts)
// rather than a per-file hoisted redirect, so no require()-in-hoisted block is
// needed. Files are cleaned up per test below.
import db from '../../server/lib/db';
import { LIBRARY_DIR } from '../../server/lib/paths';
import {
  resolveContainedObjectDir,
  getFolderName,
  deleteLocalObject,
} from '../../server/lib/library/objects';
import { getStackedImages } from '../../server/lib/library/gallery';
import { getObjectLocation } from '../../server/lib/library/objectLocation';
import { deleteLocalSession, deleteSessionSubFrames, moveObservation } from '../../server/lib/library/observations';
import { fitsCoordsForSession } from '../../server/lib/library/sessionLocation';

/**
 * Path containment for object ids.
 *
 * `getFolderName` falls back to the raw id on a DB miss, so every filesystem
 * sink that built `path.join(LIBRARY_DIR, getFolderName(id))` was reachable
 * with a crafted id. Two of the historical outcomes are the reason these tests
 * exist at all:
 *
 *   - `DELETE /library/objects/%2e` (id `'.'`) resolved to the library ROOT and
 *     then `rmSync`'d it recursively — every image, every FITS, and the
 *     `.nebulis-library.json` marker.
 *   - `..%2F..%2Ftmp` (Express decodes `%2F` inside a param) escaped the root
 *     for reads (directory listing, FITS header reads, an `exists` oracle) and
 *     for writes (unlink/mkdir/rename).
 */
const OBJECT_ID = 'M31';
const OBJECT_FOLDER = 'M 31';
const DATE = '2024-10-08';
// Express decodes `%2F`/`%2e` inside a route param BEFORE the handler runs, so
// these are the strings the resolver actually receives. (A literal
// '..%2F..%2Fetc' reaching it is a harmless single filename segment and is
// deliberately allowed — the decoded form is what matters.)
const EVIL_IDS = ['.', '..', '', '../../etc', 'a/b', 'C:\\Windows', '/etc', 'a/../../..'];

/** A library that looks real: one object folder, one session file, one marker. */
function seedLibrary(): void {
  const objDir = path.join(LIBRARY_DIR, OBJECT_FOLDER);
  fs.mkdirSync(path.join(objDir, '2024-10-08_22-00-00'), { recursive: true });
  fs.writeFileSync(path.join(objDir, '2024-10-08_22-00-00', 'Stacked_10_M31_10.0s_LP_20241008-220000.jpg'), 'jpg');
  fs.writeFileSync(path.join(LIBRARY_DIR, '.nebulis-library.json'), '{"libraryId":"test"}');
  db.prepare(
    'INSERT OR IGNORE INTO libraryObjects (objectId, folderName, fileCount, lastImport) VALUES (?, ?, 1, ?)',
  ).run(OBJECT_ID, OBJECT_FOLDER, new Date().toISOString());
}

describe('object-id path containment', () => {
  let outsideDirs: string[] = [];

  /** A real directory next to the library, plus its library-relative path. */
  const outsideDir = (): { abs: string; rel: string } => {
    const abs = fs.mkdtempSync(path.join(path.dirname(path.resolve(LIBRARY_DIR)), 'nebulis-outside-'));
    outsideDirs.push(abs);
    return { abs, rel: path.relative(path.resolve(LIBRARY_DIR), abs) };
  };

  beforeEach(() => {
    db.prepare('DELETE FROM libraryFiles').run();
    db.prepare('DELETE FROM librarySessions').run();
    db.prepare('DELETE FROM libraryObjects').run();
    fs.rmSync(path.join(LIBRARY_DIR, OBJECT_FOLDER), { recursive: true, force: true });
    seedLibrary();
  });

  afterEach(() => {
    for (const dir of outsideDirs) fs.rmSync(dir, { recursive: true, force: true });
    outsideDirs = [];
  });

  it('refuses the library root, empty names, and traversal in a folder name', () => {
    for (const id of EVIL_IDS) {
      expect(resolveContainedObjectDir(id), `id ${JSON.stringify(id)}`).toBeNull();
      // ...and with the traversal pushed through `extra` instead.
      expect(resolveContainedObjectDir(OBJECT_ID, '..', '..')).toBeNull();
    }
  });

  it('still resolves a real object to its folder strictly inside the library', () => {
    const dir = resolveContainedObjectDir(OBJECT_ID);
    expect(dir).toBe(path.join(path.resolve(LIBRARY_DIR), OBJECT_FOLDER));
    expect(dir!.startsWith(path.resolve(LIBRARY_DIR) + path.sep)).toBe(true);
  });

  it('deleteLocalObject(".") does not remove the library root', () => {
    deleteLocalObject('.');
    expect(fs.existsSync(path.join(LIBRARY_DIR, '.nebulis-library.json'))).toBe(true);
    expect(fs.existsSync(path.join(LIBRARY_DIR, OBJECT_FOLDER))).toBe(true);
  });

  it('deleteLocalObject on a traversal id leaves the outside directory alone', () => {
    const { abs, rel } = outsideDir();
    fs.writeFileSync(path.join(abs, 'keep.txt'), 'keep');
    deleteLocalObject(rel);
    expect(fs.existsSync(path.join(abs, 'keep.txt'))).toBe(true);
  });

  it('the session deleters refuse a traversal id', () => {
    const { abs, rel } = outsideDir();
    const name = 'Stacked_1_M31_10.0s_LP_20241008-220000.fit';
    fs.writeFileSync(path.join(abs, name), 'fits');

    deleteLocalSession(rel, DATE);
    expect(fs.existsSync(path.join(abs, name))).toBe(true);

    expect(deleteSessionSubFrames(rel, DATE)).toEqual({ deleted: 0 });
    expect(fs.existsSync(path.join(abs, name))).toBe(true);
  });

  it('moveObservation refuses a traversal target and creates nothing outside', () => {
    const { abs, rel } = outsideDir();
    const target = `${rel}/pwned`;

    expect(moveObservation(OBJECT_ID, DATE, target)).toEqual({ moved: 0 });
    expect(fs.existsSync(path.join(abs, 'pwned'))).toBe(false);
    // The source session is untouched.
    expect(fs.existsSync(path.join(LIBRARY_DIR, OBJECT_FOLDER, '2024-10-08_22-00-00'))).toBe(true);
  });

  it('read sinks answer with nothing rather than an outside path', async () => {
    const { abs, rel } = outsideDir();
    fs.writeFileSync(path.join(abs, 'secret.jpg'), 'jpg');

    expect(getStackedImages(rel)).toEqual([]);
    const loc = await getObjectLocation(rel);
    expect(loc.object).toEqual({ relPath: '', path: '', exists: false });
    expect(loc.object.path).not.toBe(path.join(abs, 'secret.jpg'));
    expect(fitsCoordsForSession(rel, DATE)).toBeNull();
  });

  it('keeps the raw-id fallback for benign ids (a DB miss must not break lookups)', () => {
    // Backward compatibility: an object with no row still maps to its own name,
    // which is what every caller did before the containment work.
    expect(getFolderName('NGC7000')).toBe('NGC7000');
    expect(resolveContainedObjectDir('NGC7000')).toBe(path.join(path.resolve(LIBRARY_DIR), 'NGC7000'));
  });
});
