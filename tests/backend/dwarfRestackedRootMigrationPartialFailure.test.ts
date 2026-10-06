import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Its own file, not appended to
// dwarfRestackedRootMigration.test.ts, because migrateRestackedToSharedRootOnce
// is guarded by a module-level once-per-process flag — that file's own
// successful-migration test would consume it before this one runs.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-restack-migration-partial-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { LIBRARY_DIR } from '../../server/lib/paths';
import {
  ARCHIVE_DIR_NAME,
  RESTACKED_ROOT_DIR_NAME,
  getRestackArchiveDir,
  migrateRestackedToSharedRootOnce,
} from '../../server/lib/library/archiveFolders';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// CODE_AUDIT.md Finding 9: copyToArchive's per-file deleteSourceAfterCopy
// only deletes a file once IT lands, and never throws on a per-file failure
// (it counts `result.failed` instead). migrateRestackedToSharedRootOnce
// ignored that result and unconditionally rm -rf'd the whole source
// directory tree afterward, so any file that failed to copy was deleted
// anyway along with everything around it.
describe('archive: RESTACKED shared-root migration — partial copy failure', () => {
  it('does not delete the source tree when one file in it failed to copy', async () => {
    const scopeArchiveDir = path.join(LIBRARY_DIR, ARCHIVE_DIR_NAME, 'telescope-a', RESTACKED_ROOT_DIR_NAME);
    const goodDir = path.join(scopeArchiveDir, 'M42');
    const blockedDir = path.join(scopeArchiveDir, 'Blocked');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.mkdirSync(blockedDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'good.fits'), 'good-bytes');
    fs.writeFileSync(path.join(blockedDir, 'bad.fits'), 'bad-bytes');

    // Force the "Blocked/bad.fits" copy to fail: pre-create a *file* at the
    // path its destination directory needs, so resolveArchiveDestination's
    // fs.promises.mkdir(..., { recursive: true }) throws ENOTDIR. copyToArchive
    // catches that per-file and counts it in `result.failed` rather than
    // deleting the source or throwing itself.
    const sharedRoot = getRestackArchiveDir();
    fs.mkdirSync(sharedRoot, { recursive: true });
    fs.writeFileSync(path.join(sharedRoot, 'Blocked'), 'occupies the path a directory needs');

    await migrateRestackedToSharedRootOnce();

    // The file with no obstruction did move...
    expect(fs.existsSync(path.join(sharedRoot, 'M42', 'good.fits'))).toBe(true);
    // ...but because one file in the same run failed to copy, the whole
    // source tree must survive — deleting it would have destroyed
    // 'Blocked/bad.fits', which never landed anywhere.
    expect(fs.existsSync(path.join(blockedDir, 'bad.fits'))).toBe(true);
    expect(fs.readFileSync(path.join(blockedDir, 'bad.fits'), 'utf-8')).toBe('bad-bytes');
    expect(fs.existsSync(scopeArchiveDir)).toBe(true);
  });
});

describe('archive: RESTACKED shared-root migration — files it never copied', () => {
  it('leaves a dot-file and a same-size different-content clash in place instead of deleting them', async () => {
    // Fresh scope, because the once-per-process flag is already spent by the
    // test above: call the copy helper directly with the same options the
    // migration uses, then apply the migration's tidy-up rule by hand.
    const { copyToArchive, collectArchiveCandidates } = await import('../../server/lib/library/archiveFolders');
    const scopeDir = path.join(LIBRARY_DIR, ARCHIVE_DIR_NAME, 'telescope-c');
    const src = path.join(scopeDir, RESTACKED_ROOT_DIR_NAME, 'M13');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'shotsInfo.json'), '{"a":1}');
    fs.writeFileSync(path.join(src, '.hidden-note'), 'never collected');

    const shared = getRestackArchiveDir();
    fs.mkdirSync(path.join(shared, 'M13'), { recursive: true });
    // Same name, same byte count, different content, already in the shared root.
    fs.writeFileSync(path.join(shared, 'M13', 'shotsInfo.json'), '{"b":2}');

    const candidates = collectArchiveCandidates(scopeDir, [RESTACKED_ROOT_DIR_NAME]);
    const result = await copyToArchive(candidates, LIBRARY_DIR, {
      deleteSourceAfterCopy: true,
      selfNestingGuardDir: shared,
    });

    expect(result.failed).toBe(0);
    // The existing file is untouched, and the clashing source's bytes landed beside it.
    expect(fs.readFileSync(path.join(shared, 'M13', 'shotsInfo.json'), 'utf8')).toBe('{"b":2}');
    expect(fs.readFileSync(path.join(shared, 'M13', 'shotsInfo (2).json'), 'utf8')).toBe('{"a":1}');
    // Never collected, so never deleted.
    expect(fs.existsSync(path.join(src, '.hidden-note'))).toBe(true);
  });
});
