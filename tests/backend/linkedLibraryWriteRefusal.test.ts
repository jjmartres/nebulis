import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Redirect DATA_DIR to a temp dir before any server module loads (paths.ts
// captures it at import time). Mirrors deleteLocalObjectTransaction.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-linkedrefusal-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { deleteLocalFile, deleteLocalObject, stmts } from '../../server/lib/library/objects';
import { getLibraryFilesForObject } from '../../server/lib/library/libraryFiles';
import { LinkedFileReadOnlyError } from '../../server/lib/library/fileResolver';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-linkedrefusal-source-'));
}

function linkFile(opts: { sourceId: string; rootPath: string; objectId: string; relPath: string; sourcePath: string }): void {
  db.prepare(
    `INSERT OR REPLACE INTO librarySources (id, label, rootPath, enabled, createdAt) VALUES (?, ?, ?, 1, ?)`,
  ).run(opts.sourceId, opts.sourceId, opts.rootPath, new Date().toISOString());
  db.prepare(
    `INSERT OR REPLACE INTO libraryFiles
       (objectId, relPath, fileName, originalName, role, bytes, sourceId, sourcePath, importedAt)
     VALUES (?, ?, ?, ?, 'stacked', 5, ?, ?, ?)`,
  ).run(opts.objectId, opts.relPath, opts.relPath.split('/').pop(), opts.relPath.split('/').pop(),
    opts.sourceId, opts.sourcePath, new Date().toISOString());
}

describe('linked (non-copied) library files are never mutated or deleted', () => {
  let sourceRoot: string;
  const objectId = 'RefusalTestObj';

  beforeEach(() => {
    sourceRoot = tmpDir();
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(objectId);
  });

  it('deleteLocalFile refuses a linked row and leaves the real file on disk untouched', () => {
    fs.writeFileSync(path.join(sourceRoot, 'photo.jpg'), 'original-bytes');
    const relPath = `@src/src_refuse/photo.jpg`;
    linkFile({ sourceId: 'src_refuse', rootPath: sourceRoot, objectId, relPath, sourcePath: 'photo.jpg' });

    const beforeStat = fs.statSync(path.join(sourceRoot, 'photo.jpg'));

    expect(() => deleteLocalFile(relPath)).toThrow(LinkedFileReadOnlyError);
    try {
      deleteLocalFile(relPath);
    } catch (err) {
      expect(err).toBeInstanceOf(LinkedFileReadOnlyError);
      expect((err as LinkedFileReadOnlyError).code).toBe('LINKED_FILE_READONLY');
    }

    // The row is untouched (not deleted) and the real file on disk is
    // byte-for-byte and mtime-for-mtime unchanged.
    expect(getLibraryFilesForObject(objectId)).toHaveLength(1);
    const afterStat = fs.statSync(path.join(sourceRoot, 'photo.jpg'));
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(fs.readFileSync(path.join(sourceRoot, 'photo.jpg'), 'utf8')).toBe('original-bytes');
  });

  it('deleteLocalFile still works exactly as before for a managed file — this refusal is scoped to linked rows only', () => {
    const managedDir = path.join(getLibraryDir(), objectId);
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(path.join(managedDir, 'Stacked_1.jpg'), 'x');
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, bytes, importedAt)
       VALUES (?, ?, ?, ?, 'stacked', 1, ?)`,
    ).run(objectId, `${objectId}/Stacked_1.jpg`, 'Stacked_1.jpg', 'Stacked_1.jpg', new Date().toISOString());
    stmts.upsertObject.run(
      objectId, objectId, 1, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );

    expect(() => deleteLocalFile(`${objectId}/Stacked_1.jpg`)).not.toThrow();
    expect(fs.existsSync(path.join(managedDir, 'Stacked_1.jpg'))).toBe(false);
  });

  it('deleteLocalObject tombstones an object with linked files and drops all its libraryFiles rows, but never touches the linked bytes on disk', () => {
    fs.writeFileSync(path.join(sourceRoot, 'photo.jpg'), 'still-here');
    const relPath = `@src/src_deleteobj/photo.jpg`;
    linkFile({ sourceId: 'src_deleteobj', rootPath: sourceRoot, objectId, relPath, sourcePath: 'photo.jpg' });
    stmts.upsertObject.run(
      objectId, objectId, 1, new Date().toISOString(), 0, null,
      null, null, null, null, null, null, null, null, null,
    );

    expect(() => deleteLocalObject(objectId)).not.toThrow();

    const row = db.prepare<[string], { deleted: number }>(
      'SELECT deleted FROM libraryObjects WHERE objectId = ?',
    ).get(objectId);
    expect(row?.deleted).toBe(1);
    // The library stops tracking the object entirely — same as a managed-only
    // object — but the file itself, on the user's own disk, is never touched.
    expect(getLibraryFilesForObject(objectId)).toHaveLength(0);
    expect(fs.readFileSync(path.join(sourceRoot, 'photo.jpg'), 'utf8')).toBe('still-here');
  });
});
