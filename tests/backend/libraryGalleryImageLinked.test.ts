import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors galleryImageTraversal.test.ts,
// the existing test this one sits alongside.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-gallerylinked-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { resolveObjectImagePath, setGalleryImageUserChosen } from '../../server/lib/library/gallery';
import { stmts } from '../../server/lib/library/objects';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
});
afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM libraryObjects').run();
  db.prepare('DELETE FROM libraryFiles').run();
  db.prepare('DELETE FROM librarySources').run();
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
});

// A gallery image is a
// DB pointer, not a bytes mutation, so a linked object's own linked photo must
// be a legitimate choice — refusing it here would be a feature regression, not
// a safety fix. This is the positive counterpart to galleryImageTraversal.test.ts,
// which proves the refusal side of the same code path.
describe('resolveObjectImagePath — a linked object\'s own file as its gallery image', () => {
  it('resolves an indexed @src/ gallery image to the real file on the source disk', async () => {
    stmts.upsertObject.run(
      'M31', 'M31', 0, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );

    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-gallerylinked-source-'));
    fs.writeFileSync(path.join(sourceRoot, 'Stacked_1.jpg'), 'linked-hero-image');
    db.prepare(
      `INSERT INTO librarySources (id, label, rootPath, enabled, createdAt) VALUES (?, ?, ?, 1, ?)`,
    ).run('src_gallery', 'src_gallery', sourceRoot, new Date().toISOString());
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, bytes, sourceId, sourcePath, importedAt)
       VALUES ('M31', '@src/src_gallery/Stacked_1.jpg', 'Stacked_1.jpg', 'Stacked_1.jpg', 'stacked', 5, 'src_gallery', 'Stacked_1.jpg', ?)`,
    ).run(new Date().toISOString());

    setGalleryImageUserChosen('M31', '@src/src_gallery/Stacked_1.jpg');

    const resolved = await resolveObjectImagePath('M31');
    expect(resolved).toBe(path.resolve(sourceRoot, 'Stacked_1.jpg'));

    fs.rmSync(sourceRoot, { recursive: true, force: true });
  });

  it('still refuses a @src/ value with no matching indexed row — this is not a blanket allowance', async () => {
    stmts.upsertObject.run(
      'M42', 'M42', 0, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );
    setGalleryImageUserChosen('M42', '@src/nonexistent-source/whatever.jpg');

    const resolved = await resolveObjectImagePath('M42');
    expect(resolved).toBeNull();
  });
});
