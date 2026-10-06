import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';

// Redirect DATA_DIR before any server module loads (paths.ts captures it at
// import time). Mirrors deleteLocalFileProcessedImage.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-unmark-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { stmts, deleteLocalFile } from '../../server/lib/library/objects';
import { moveProcessedImageToLibrary } from '../../server/lib/library/processed';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

const OBJECT_ID = 'UnmarkTestObj';
const DATE = '2026-05-25';

function seedProcessed(id: string, filename: string) {
  fs.writeFileSync(path.join(LIBRARY_DIR, OBJECT_ID, 'processed', filename), 'pixels');
  stmts.insertProcessedImage.run(
    id, OBJECT_ID, DATE, filename, filename, '', '', 6, 'image/jpeg', new Date().toISOString(), null, 'user',
  );
}

function libraryRows() {
  return db.prepare<[string], { relPath: string; sessionDateOverride: string | null; telescopeId: string | null }>(
    'SELECT relPath, sessionDateOverride, telescopeId FROM libraryFiles WHERE objectId = ?',
  ).all(OBJECT_ID);
}

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(OBJECT_ID);
  db.prepare('DELETE FROM sessionProcessedImages WHERE objectId = ?').run(OBJECT_ID);
  db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(OBJECT_ID);
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(LIBRARY_DIR, OBJECT_ID, 'processed'), { recursive: true });
  stmts.upsertObject.run(
    OBJECT_ID, OBJECT_ID, 0, new Date().toISOString(), 0, null,
    null, null, null, null, null, null, null, null, null,
  );
});

describe('moveProcessedImageToLibrary', () => {
  it('moves the file into the session folder and registers it on that night', () => {
    seedProcessed('p1', 'final_edit.jpg');

    const rel = moveProcessedImageToLibrary('p1', { sessionFolder: '2026-05-25_00-00-00', telescopeId: 'scope1' });

    expect(rel).toBe(`${OBJECT_ID}/2026-05-25_00-00-00/final_edit.jpg`);
    expect(fs.existsSync(path.join(LIBRARY_DIR, rel!))).toBe(true);
    expect(fs.existsSync(path.join(LIBRARY_DIR, OBJECT_ID, 'processed', 'final_edit.jpg'))).toBe(false);
    expect(stmts.getProcessedImage.get('p1')).toBeUndefined();
    // A name parseFilename can't read still belongs to this night.
    expect(libraryRows()).toEqual([{ relPath: rel, sessionDateOverride: DATE, telescopeId: 'scope1' }]);
  });

  it('puts the file at object level for a flat object', () => {
    seedProcessed('p1', 'final_edit.jpg');
    const rel = moveProcessedImageToLibrary('p1', { sessionFolder: null, telescopeId: null });
    expect(rel).toBe(`${OBJECT_ID}/final_edit.jpg`);
    expect(fs.existsSync(path.join(LIBRARY_DIR, OBJECT_ID, 'final_edit.jpg'))).toBe(true);
  });

  it('never overwrites a file already in the destination', () => {
    fs.mkdirSync(path.join(LIBRARY_DIR, OBJECT_ID, 'S'), { recursive: true });
    fs.writeFileSync(path.join(LIBRARY_DIR, OBJECT_ID, 'S', 'a.jpg'), 'original');
    seedProcessed('p1', 'a.jpg');

    const rel = moveProcessedImageToLibrary('p1', { sessionFolder: 'S', telescopeId: null });

    expect(rel).toBe(`${OBJECT_ID}/S/a (2).jpg`);
    expect(fs.readFileSync(path.join(LIBRARY_DIR, OBJECT_ID, 'S', 'a.jpg'), 'utf8')).toBe('original');
  });

  it('carries a crowned session image over to the new path', () => {
    stmts.addSession.run(OBJECT_ID, DATE);
    seedProcessed('p1', 'final_edit.jpg');
    stmts.setSessionImage.run(`${OBJECT_ID}/processed/final_edit.jpg`, OBJECT_ID, DATE);

    const rel = moveProcessedImageToLibrary('p1', { sessionFolder: 'S', telescopeId: null });

    expect(stmts.getSessionImage.get(OBJECT_ID, DATE)?.sessionImage).toBe(rel);
  });

  it('returns null for an unknown id and for an image with no night', () => {
    expect(moveProcessedImageToLibrary('nope', { sessionFolder: null, telescopeId: null })).toBeNull();
    stmts.insertProcessedImage.run(
      'p2', OBJECT_ID, null, 'x.jpg', 'x.jpg', '', '', 0, 'image/jpeg', new Date().toISOString(), null, 'user',
    );
    expect(moveProcessedImageToLibrary('p2', { sessionFolder: null, telescopeId: null })).toBeNull();
  });

  it('round-trips with the promote path: moving back leaves nothing processed', () => {
    fs.mkdirSync(path.join(LIBRARY_DIR, OBJECT_ID, 'S'), { recursive: true });
    seedProcessed('p1', 'b.jpg');
    moveProcessedImageToLibrary('p1', { sessionFolder: 'S', telescopeId: null });
    // The file is now an ordinary library file: the regular delete owns it.
    expect(() => deleteLocalFile(`${OBJECT_ID}/S/b.jpg`)).not.toThrow();
    expect(libraryRows()).toEqual([]);
  });
});
