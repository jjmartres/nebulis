import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-archivelinked-test-'));
  _process.env.DATA_DIR = dir;
  _process.env.DATA_KEY = Buffer.alloc(32, 5).toString('base64');
  return dir;
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import db from '../../server/lib/db';
import { resolveArchiveRoot } from '../../server/lib/archive/archivePath';
import { ensureArchiveDestinationReady } from '../../server/lib/archive/archiveDestination';
import { writeArchiveMarker } from '../../server/lib/archive/archiveMarker';
import { DEFAULT_ARCHIVE_CONFIG, getArchiveConfig, setArchiveConfig } from '../../server/lib/archive/archiveConfig';
import { assertLinkableRoot, LinkSourceError } from '../../server/lib/library/librarySources';

/**
 * A linked folder holds the user's own originals, and the archive both writes
 * into its destination and deletes from it when pruning. So the two must never
 * overlap, in either direction, and the check has to hold no matter which one
 * was set up first.
 */

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A linked source row, written directly so the "linked after the destination was
 *  saved" order can be set up without going through the guard under test. */
function linkFolder(rootPath: string, label = 'Captures'): void {
  db.prepare('INSERT INTO librarySources (id, label, rootPath, createdAt) VALUES (?, ?, ?, ?)').run(
    `src_${Math.random().toString(36).slice(2)}`, label, rootPath, new Date().toISOString(),
  );
}

afterEach(() => {
  db.prepare('DELETE FROM librarySources').run();
  setArchiveConfig(DEFAULT_ARCHIVE_CONFIG);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function reasonOf(candidate: string): string | null {
  const result = resolveArchiveRoot(candidate);
  return result.ok ? null : result.reason;
}

describe('an archive destination against linked folders', () => {
  it('is refused when it is a linked folder', () => {
    const captures = tmp('nebulis-linked-');
    linkFolder(captures);
    expect(reasonOf(captures)).toBe('overlaps-linked-source');
  });

  it('is refused when it sits inside a linked folder', () => {
    const captures = tmp('nebulis-linked-');
    linkFolder(captures);
    expect(reasonOf(path.join(captures, 'archive'))).toBe('overlaps-linked-source');
  });

  it('is refused when it contains a linked folder', () => {
    const parent = tmp('nebulis-linked-parent-');
    const captures = path.join(parent, 'captures');
    fs.mkdirSync(captures);
    linkFolder(captures);
    expect(reasonOf(parent)).toBe('overlaps-linked-source');
  });

  it('is refused through a symlinked parent', () => {
    const captures = tmp('nebulis-linked-');
    const elsewhere = tmp('nebulis-linked-elsewhere-');
    const link = path.join(elsewhere, 'shortcut');
    fs.symlinkSync(captures, link, 'dir');
    linkFolder(captures);
    expect(reasonOf(path.join(link, 'archive'))).toBe('overlaps-linked-source');
  });

  it('is accepted when it is a sibling of a linked folder', () => {
    linkFolder(tmp('nebulis-linked-'));
    const disk = tmp('nebulis-archive-disk-');
    expect(reasonOf(disk)).toBeNull();
  });

  it('is refused on every later resolution once a folder is linked over it', async () => {
    const disk = tmp('nebulis-archive-disk-');
    writeArchiveMarker(disk, 'archive-under-test');
    setArchiveConfig({ ...getArchiveConfig(), path: disk, archiveId: 'archive-under-test', enabled: true });
    expect((await ensureArchiveDestinationReady(getArchiveConfig())).ok).toBe(true);

    linkFolder(path.dirname(disk));

    const readiness = await ensureArchiveDestinationReady(getArchiveConfig());
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.reason).toBe('overlaps-linked-source');
  });
});

describe('linking a folder against the archive destination', () => {
  function configureArchive(dest: string): void {
    setArchiveConfig({ ...getArchiveConfig(), path: dest, archiveId: 'archive-under-test', enabled: true });
  }

  function linkErrorOf(rootPath: string): string | null {
    try {
      assertLinkableRoot(rootPath);
      return null;
    } catch (err) {
      return err instanceof LinkSourceError ? err.code : 'OTHER';
    }
  }

  it('is refused when the folder is the archive destination', () => {
    const disk = tmp('nebulis-archive-disk-');
    configureArchive(disk);
    expect(linkErrorOf(disk)).toBe('OVERLAPS_ARCHIVE');
  });

  it('is refused when the folder holds the archive destination', () => {
    const parent = tmp('nebulis-linked-parent-');
    const disk = path.join(parent, 'archive');
    fs.mkdirSync(disk);
    configureArchive(disk);
    expect(linkErrorOf(parent)).toBe('OVERLAPS_ARCHIVE');
  });

  it('is refused when the folder sits inside the archive destination', () => {
    const disk = tmp('nebulis-archive-disk-');
    const inside = path.join(disk, 'M 31');
    fs.mkdirSync(inside);
    configureArchive(disk);
    expect(linkErrorOf(inside)).toBe('OVERLAPS_ARCHIVE');
  });

  it('is refused through a symlink to the archive destination', () => {
    const disk = tmp('nebulis-archive-disk-');
    const elsewhere = tmp('nebulis-linked-elsewhere-');
    const link = path.join(elsewhere, 'shortcut');
    fs.symlinkSync(disk, link, 'dir');
    configureArchive(disk);
    expect(linkErrorOf(link)).toBe('OVERLAPS_ARCHIVE');
  });

  it('is accepted when the archive is elsewhere', () => {
    configureArchive(tmp('nebulis-archive-disk-'));
    expect(linkErrorOf(tmp('nebulis-linked-'))).toBeNull();
  });

  it('is accepted when no archive is configured', () => {
    expect(linkErrorOf(tmp('nebulis-linked-'))).toBeNull();
  });
});
