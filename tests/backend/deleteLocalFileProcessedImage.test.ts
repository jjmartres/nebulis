import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors deleteLocalFileNestedLayout.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-processedimage-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { deleteLocalFile, stmts } from '../../server/lib/library/objects';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

const OBJECT_ID = 'ProcessedTestObj';

function insertProcessedRow(filename: string) {
  stmts.insertProcessedImage.run(
    'proc_test_1', OBJECT_ID, '2026-05-25', filename, filename,
    '', '', 0, 'image/png', new Date().toISOString(), null, 'user',
  );
}

function processedRowCount(): number {
  return db.prepare<[string], { c: number }>('SELECT COUNT(*) as c FROM sessionProcessedImages WHERE objectId = ?')
    .get(OBJECT_ID)!.c;
}

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(OBJECT_ID);
  db.prepare('DELETE FROM sessionProcessedImages WHERE objectId = ?').run(OBJECT_ID);
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });

  stmts.upsertObject.run(
    OBJECT_ID, OBJECT_ID, 0, new Date().toISOString(), 0, null,
    null, null, null, null, null, null, null, null, null,
  );

  const processedDir = path.join(LIBRARY_DIR, OBJECT_ID, 'processed');
  fs.mkdirSync(processedDir, { recursive: true });
});

describe('deleteLocalFile — processed images', () => {
  it('removes the sessionProcessedImages row when the file exists on disk', () => {
    insertProcessedRow('image7.png');
    fs.writeFileSync(path.join(LIBRARY_DIR, OBJECT_ID, 'processed', 'image7.png'), 'x');

    deleteLocalFile(`${OBJECT_ID}/processed/image7.png`);

    expect(processedRowCount()).toBe(0);
    expect(fs.existsSync(path.join(LIBRARY_DIR, OBJECT_ID, 'processed', 'image7.png'))).toBe(false);
  });

  // Reproduces a real stuck state: a sessionProcessedImages row survives a
  // file that is already gone (deleted out of band, or by a prior delete that
  // only removed the file). The generic file-path delete used to throw "File
  // not found" here, which meant the row could never be cleared through the UI.
  it('still clears an orphaned row when the file is already missing', () => {
    insertProcessedRow('image7.png');
    // Deliberately no file written to disk.

    expect(() => deleteLocalFile(`${OBJECT_ID}/processed/image7.png`)).not.toThrow();
    expect(processedRowCount()).toBe(0);
  });

  it('still throws for a genuinely missing raw (non-processed) file', () => {
    expect(() => deleteLocalFile(`${OBJECT_ID}/nonexistent.fits`)).toThrow('File not found');
  });
});
