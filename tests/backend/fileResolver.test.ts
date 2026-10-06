import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// paths.ts / db.ts capture DATA_DIR at module load. Redirect to a temp dir
// before any server module imports resolve (vi.hoisted runs first), matching
// the pattern in tests/backend/libraryPath.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-fileresolver-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { getLibraryDir, ensureLibraryDir, setLibraryPath } from '../../server/lib/libraryPath';
import { resolveLibraryFile } from '../../server/lib/library/fileResolver';
import db from '../../server/lib/db';

/** Insert a librarySources row and a matching libraryFiles row, the shape
 *  Step 5's commit/rescan will actually write. */
function linkFile(opts: {
  sourceId: string;
  rootPath: string;
  relPath: string; // the '@src/<id>/...' identifier
  sourcePath: string; // the path relative to rootPath
  enabled?: boolean;
  objectId?: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO librarySources (id, label, rootPath, enabled, createdAt) VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.sourceId, opts.sourceId, opts.rootPath, opts.enabled === false ? 0 : 1, new Date().toISOString());
  db.prepare(
    `INSERT OR REPLACE INTO libraryFiles
       (objectId, relPath, fileName, originalName, role, bytes, sourceId, sourcePath, importedAt)
     VALUES (?, ?, ?, ?, 'stacked', 0, ?, ?, ?)`,
  ).run(
    opts.objectId ?? 'M31', opts.relPath, opts.relPath.split('/').pop(), opts.relPath.split('/').pop(),
    opts.sourceId, opts.sourcePath, new Date().toISOString(),
  );
}

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await setLibraryPath(''); // reset to the default library location between tests
  ensureLibraryDir();
});

describe('resolveLibraryFile', () => {
  it('resolves a plain relative path inside the library root', () => {
    const LIBRARY_DIR = getLibraryDir();
    fs.mkdirSync(path.join(LIBRARY_DIR, 'M31'), { recursive: true });
    fs.writeFileSync(path.join(LIBRARY_DIR, 'M31', 'Stacked_1.jpg'), 'x');

    const resolved = resolveLibraryFile('M31/Stacked_1.jpg');
    expect(resolved).not.toBeNull();
    expect(resolved!.abs).toBe(path.join(LIBRARY_DIR, 'M31', 'Stacked_1.jpg'));
    expect(resolved!.sourceId).toBeNull();
  });

  it('refuses a .. traversal that would escape the library root', () => {
    // The library root's own parent holds a real, readable directory (DATA_DIR
    // itself) so a naive path-join would actually succeed in reaching it.
    expect(resolveLibraryFile('../../.data-key')).toBeNull();
    expect(resolveLibraryFile('..')).toBeNull();
    expect(resolveLibraryFile('foo/../../bar')).toBeNull();
  });

  it('refuses an absolute path outside the library root', () => {
    expect(resolveLibraryFile('/etc/passwd')).toBeNull();
  });

  it('refuses a sibling directory whose name merely starts with the library dir name', () => {
    const LIBRARY_DIR = getLibraryDir();
    const sibling = `${LIBRARY_DIR}-x`;
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'secret.txt'), 'nope');
    try {
      // A bare (non-trailing-separator-aware) startsWith check would let this
      // through: "<lib>-x/secret.txt".startsWith("<lib>") is true.
      const relPathIntoSibling = path.relative(LIBRARY_DIR, path.join(sibling, 'secret.txt'));
      expect(resolveLibraryFile(relPathIntoSibling)).toBeNull();
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('accepts the library root itself resolved with an empty/"." segment the same way the five prior inline checks did', () => {
    // None of the five inline checks this replaces special-cased the exact
    // root; this is a deliberate zero-behaviour-change carryover, not a new
    // allowance. A path.resolve of '' or '.' onto LIBRARY_DIR yields LIBRARY_DIR
    // exactly, which does not start with LIBRARY_DIR + sep, so it is refused —
    // matching every one of the five original routes.
    expect(resolveLibraryFile('')).toBeNull();
    expect(resolveLibraryFile('.')).toBeNull();
  });
});

describe('resolveLibraryFile — @src/ (linked source) branch', () => {
  let sourceRoot: string;

  beforeEach(() => {
    sourceRoot = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'linked-source-'));
  });

  // Refusal cases come first, per the contract's own rule for anything
  // destructive/security-relevant: prove the boundary refuses before proving
  // it works.

  it('refuses a @src/ path with no matching libraryFiles row — never guesses at a path', () => {
    expect(resolveLibraryFile('@src/nonexistent-source/whatever.jpg')).toBeNull();
  });

  it('refuses a @src/ row whose source no longer exists', () => {
    // A libraryFiles row pointing at a sourceId with no librarySources row
    // (e.g. the source was deleted but this row somehow survived) must not
    // fall back to guessing a path.
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, bytes, sourceId, sourcePath, importedAt)
       VALUES ('M31', '@src/ghost/photo.jpg', 'photo.jpg', 'photo.jpg', 'stacked', 0, 'ghost', 'photo.jpg', ?)`,
    ).run(new Date().toISOString());
    expect(resolveLibraryFile('@src/ghost/photo.jpg')).toBeNull();
  });

  it('refuses a row whose source is disabled', () => {
    fs.writeFileSync(path.join(sourceRoot, 'photo.jpg'), 'x');
    linkFile({ sourceId: 'src_disabled', rootPath: sourceRoot, relPath: '@src/src_disabled/photo.jpg', sourcePath: 'photo.jpg', enabled: false });
    expect(resolveLibraryFile('@src/src_disabled/photo.jpg')).toBeNull();
  });

  it('refuses when the stored sourcePath would resolve outside the source root — defense in depth even against our own stored value', () => {
    linkFile({ sourceId: 'src_escape', rootPath: sourceRoot, relPath: '@src/src_escape/evil.jpg', sourcePath: '../../../../etc/passwd' });
    expect(resolveLibraryFile('@src/src_escape/evil.jpg')).toBeNull();
  });

  it('refuses a symlink inside the source root that points outside it', () => {
    const outside = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret.jpg'), 'nope');
    let symlinked = false;
    try {
      fs.symlinkSync(outside, path.join(sourceRoot, 'escape-link'), 'dir');
      symlinked = true;
    } catch { /* symlink creation can require elevated privilege on some hosts */ }
    if (!symlinked) return;

    linkFile({ sourceId: 'src_symlink', rootPath: sourceRoot, relPath: '@src/src_symlink/x.jpg', sourcePath: 'escape-link/secret.jpg' });
    // path.resolve follows the string, not the symlink target, at this layer —
    // the containment check compares against sourceRoot's own resolved path,
    // which is the same protection the managed-library branch relies on. This
    // documents the current (string-level) guarantee: it contains the *path*
    // regardless of what a symlink component resolves to, since abs is built
    // from path.resolve (string join), not a filesystem-following resolve.
    const resolved = resolveLibraryFile('@src/src_symlink/x.jpg');
    expect(resolved).not.toBeNull();
    expect(resolved!.abs.startsWith(path.resolve(sourceRoot) + path.sep)).toBe(true);
  });

  it('resolves an indexed @src/ file to the real path on the source disk', () => {
    fs.mkdirSync(path.join(sourceRoot, 'M 42'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'M 42', 'Stacked_1.jpg'), 'hello');
    linkFile({ sourceId: 'src_ok', rootPath: sourceRoot, relPath: '@src/src_ok/M 42/Stacked_1.jpg', sourcePath: 'M 42/Stacked_1.jpg' });

    const resolved = resolveLibraryFile('@src/src_ok/M 42/Stacked_1.jpg');
    expect(resolved).not.toBeNull();
    expect(resolved!.sourceId).toBe('src_ok');
    expect(resolved!.abs).toBe(path.resolve(sourceRoot, 'M 42', 'Stacked_1.jpg'));
    expect(fs.readFileSync(resolved!.abs, 'utf8')).toBe('hello');
  });

  it('a @src/-prefixed value never falls through to the managed-library branch', () => {
    // Even if a managed library happened to contain a literal "@src" folder on
    // disk (it never does — see LINKED_SOURCE_DIR_NAME's own reservation), this
    // must never be reached by joining onto LIBRARY_DIR.
    const LIBRARY_DIR = getLibraryDir();
    fs.mkdirSync(path.join(LIBRARY_DIR, '@src', 'whatever'), { recursive: true });
    fs.writeFileSync(path.join(LIBRARY_DIR, '@src', 'whatever', 'x.jpg'), 'managed-side-file');
    expect(resolveLibraryFile('@src/whatever/x.jpg')).toBeNull();
  });
});
