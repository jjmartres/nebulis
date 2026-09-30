import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// A scratch DATA_DIR before any server module loads: both mount directories are
// derived from it at import time.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-archive-mount-'));
  _process.env.DATA_DIR = dir;
  _process.env.DATA_KEY = Buffer.alloc(32, 5).toString('base64');
  return dir;
});

import fs from 'fs';
import path from 'path';

import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { storageRouter } from '../../server/routes/storage';
import { ARCHIVE_NETWORK_MOUNT_DIR } from '../../server/lib/archive/archiveNetwork';
import { NETWORK_MOUNT_DIR } from '../../server/lib/libraryNetwork';

/**
 * The archive's mount point, and keeping it out of the local-storage figures.
 *
 * Two mount points can hold two shares, so the archive must not reuse the library's:
 * they can point at different servers at the same time, and one directory cannot hold
 * both. And because the archive's lives under DATA_DIR like the library's, the sync
 * walks behind Settings' "Local Server" figures have to skip it. A walk that
 * descended into it would recurse into a network share on every settings load, which
 * blocks the event loop, and would count the share's bytes as this machine's.
 *
 * The visible directory in the test is what makes the skip assertion non-vacuous:
 * without it, a breakdown that returned nothing at all would pass.
 */

const GHOST_BYTES = 64 * 1024;
const VISIBLE_BYTES = 12345;

let server: http.Server;
let baseUrl: string;

async function getSystem(): Promise<{
  dataDir: { size: number; files: number; breakdown: Array<{ name: string; size: number; files: number }> };
}> {
  const res = await fetch(`${baseUrl}/storage/system`);
  const body = (await res.json()) as { data: { dataDir: { size: number; files: number; breakdown: Array<{ name: string; size: number; files: number }> } } };
  return body.data;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test';
    req.userId = 'u';
    req.username = 'tester';
    req.userRole = 'admin';
    next();
  });
  app.use('/storage', storageRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  for (const dir of [ARCHIVE_NETWORK_MOUNT_DIR, NETWORK_MOUNT_DIR, path.join(TEST_DATA_DIR, 'visible-test-dir')]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFileOfSize(dir: string, name: string, bytes: number): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 7));
}

describe('the two mount points', () => {
  it('are different directories, so two shares can be mounted at once', () => {
    expect(ARCHIVE_NETWORK_MOUNT_DIR).not.toBe(NETWORK_MOUNT_DIR);
  });

  it('both live under DATA_DIR, so a resolved path survives a restart', () => {
    for (const dir of [ARCHIVE_NETWORK_MOUNT_DIR, NETWORK_MOUNT_DIR]) {
      expect(path.dirname(dir)).toBe(TEST_DATA_DIR);
    }
  });
});

describe('the local-storage walk', () => {
  it('skips both mount points and still counts everything else', async () => {
    writeFileOfSize(ARCHIVE_NETWORK_MOUNT_DIR, 'ghost.bin', GHOST_BYTES);
    writeFileOfSize(NETWORK_MOUNT_DIR, 'ghost.bin', GHOST_BYTES);
    writeFileOfSize(path.join(TEST_DATA_DIR, 'visible-test-dir'), 'real.bin', VISIBLE_BYTES);

    const withGhosts = (await getSystem()).dataDir;
    const names = withGhosts.breakdown.map(entry => entry.name);

    // The premise: an ordinary directory of the same shape *is* walked, with its
    // real bytes, so a breakdown that returned nothing could not pass this test.
    const visible = withGhosts.breakdown.find(entry => entry.name === 'visible-test-dir');
    expect(visible).toBeDefined();
    expect(visible?.size).toBe(VISIBLE_BYTES);
    expect(visible?.files).toBe(1);

    // The mounted shares are not top-level entries at all...
    expect(names).not.toContain(path.basename(ARCHIVE_NETWORK_MOUNT_DIR));
    expect(names).not.toContain(path.basename(NETWORK_MOUNT_DIR));

    // ...and removing their contents does not move the total, which is the part a
    // name check alone would not catch: a walk could skip the entry and still have
    // counted its files through some other path.
    fs.rmSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true, force: true });
    fs.rmSync(NETWORK_MOUNT_DIR, { recursive: true, force: true });
    const withoutGhosts = (await getSystem()).dataDir;

    // Not an exact equality: the server's own log file grows between the two
    // requests. Two ghost directories of GHOST_BYTES each would move this figure by
    // at least twice that, so a delta below one of them is unambiguous.
    expect(Math.abs(withoutGhosts.size - withGhosts.size)).toBeLessThan(GHOST_BYTES);
  });
});
