import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// paths.ts / db.ts capture DATA_DIR at module load, matching the pattern in
// tests/backend/libraryPath.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-libsources-schema-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import db from '../../server/lib/db';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('librarySources schema (fresh install)', () => {
  it('creates the librarySources table with the expected columns', () => {
    const cols = db.prepare<[], { name: string }>('PRAGMA table_info(librarySources)').all().map(c => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'label', 'rootPath', 'fingerprint', 'enabled', 'lastScanAt', 'lastScanStats', 'createdAt']),
    );
  });

  it('accepts a round-tripped row', () => {
    db.prepare(
      `INSERT INTO librarySources (id, label, rootPath, enabled, createdAt) VALUES (?, ?, ?, 1, ?)`,
    ).run('src_test1', 'MyWorks', '/Users/test/MyWorks', new Date().toISOString());
    const row = db.prepare<[string], { id: string; label: string; rootPath: string }>(
      'SELECT id, label, rootPath FROM librarySources WHERE id = ?',
    ).get('src_test1');
    expect(row).toEqual({ id: 'src_test1', label: 'MyWorks', rootPath: '/Users/test/MyWorks' });
  });

  it('gives libraryFiles the sourceId, mtimeMs, and missingSince columns, indexed on sourceId', () => {
    const cols = db.prepare<[], { name: string }>('PRAGMA table_info(libraryFiles)').all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['sourceId', 'mtimeMs', 'missingSince']));

    const indexes = db.prepare<[], { name: string }>("PRAGMA index_list(libraryFiles)").all().map(i => i.name);
    expect(indexes).toContain('idx_libraryFiles_source');
  });

  it('a pre-existing (managed) libraryFiles row defaults sourceId to NULL', () => {
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, bytes, importedAt)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).run('M31', 'M31/Stacked_1.jpg', 'Stacked_1.jpg', 'Stacked_1.jpg', 'stacked', new Date().toISOString());
    const row = db.prepare<[string], { sourceId: string | null }>(
      'SELECT sourceId FROM libraryFiles WHERE relPath = ?',
    ).get('M31/Stacked_1.jpg');
    expect(row?.sourceId).toBeNull();
  });
});

describe('librarySources / libraryFiles column migration (pre-existing database)', () => {
  it('adds the new columns and index to a database that predates them, without touching existing data', () => {
    // Build a standalone DB file shaped like the libraryFiles table looked
    // before this feature, insert a row, then run db.ts's own migration SQL
    // against it directly (the same ALTER statements added to db.ts, kept in
    // sync by inspection — this proves the *statements* are valid and
    // idempotent against a real pre-existing table, not that db.ts's own
    // module-load sequencing is correct, which the fresh-install tests above
    // already exercise every time they run).
    const dir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'legacy-db-'));
    const dbPath = path.join(dir, 'legacy.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE libraryFiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objectId TEXT NOT NULL,
        relPath TEXT NOT NULL UNIQUE,
        fileName TEXT NOT NULL,
        originalName TEXT NOT NULL,
        role TEXT NOT NULL,
        captureDate TEXT,
        captureTime TEXT,
        sessionDateOverride TEXT,
        telescopeId TEXT,
        bytes INTEGER NOT NULL DEFAULT 0,
        sourcePath TEXT,
        importedAt TEXT NOT NULL
      );
    `);
    legacy.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, bytes, importedAt)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).run('M42', 'M42/Stacked_1.jpg', 'Stacked_1.jpg', 'Stacked_1.jpg', 'stacked', '2026-01-01T00:00:00.000Z');

    // The exact migration this feature added to db.ts's "Column migrations for
    // existing databases" section.
    const cols = legacy.prepare<[], { name: string }>('PRAGMA table_info(libraryFiles)').all();
    if (!cols.some(c => c.name === 'sourceId')) legacy.exec('ALTER TABLE libraryFiles ADD COLUMN sourceId TEXT');
    if (!cols.some(c => c.name === 'mtimeMs')) legacy.exec('ALTER TABLE libraryFiles ADD COLUMN mtimeMs INTEGER');
    if (!cols.some(c => c.name === 'missingSince')) legacy.exec('ALTER TABLE libraryFiles ADD COLUMN missingSince TEXT');
    legacy.exec('CREATE INDEX IF NOT EXISTS idx_libraryFiles_source ON libraryFiles(sourceId)');

    const row = legacy.prepare<[string], { objectId: string; sourceId: string | null; relPath: string }>(
      'SELECT objectId, sourceId, relPath FROM libraryFiles WHERE relPath = ?',
    ).get('M42/Stacked_1.jpg');
    expect(row).toEqual({ objectId: 'M42', sourceId: null, relPath: 'M42/Stacked_1.jpg' });

    // Idempotent: running it again (simulating a second boot) doesn't throw.
    const cols2 = legacy.prepare<[], { name: string }>('PRAGMA table_info(libraryFiles)').all();
    expect(() => {
      if (!cols2.some(c => c.name === 'sourceId')) legacy.exec('ALTER TABLE libraryFiles ADD COLUMN sourceId TEXT');
      legacy.exec('CREATE INDEX IF NOT EXISTS idx_libraryFiles_source ON libraryFiles(sourceId)');
    }).not.toThrow();

    legacy.close();
  });
});
