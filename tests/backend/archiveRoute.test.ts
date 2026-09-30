import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR before any server module loads (paths.ts captures it at
// import time). Same idiom as libraryLocationResetRoute.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-archiveroute-test-'));
  _process.env.DATA_DIR = dir;
  _process.env.DATA_KEY = Buffer.alloc(32, 5).toString('base64');
  return dir;
});

import fs from 'fs';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { storageRouter } from '../../server/routes/storage';
import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { setArchiveConfig, getArchiveConfig, DEFAULT_ARCHIVE_CONFIG } from '../../server/lib/archive/archiveConfig';
import type { ArchiveConfig } from '../../server/lib/archive/archiveConfig';
import { ARCHIVE_MARKER_FILENAME, parseArchiveMarker, writeArchiveMarker } from '../../server/lib/archive/archiveMarker';

/**
 * The archive configuration routes.
 *
 * These are the first part of the feature that a request can reach, so the tests
 * are about what a request is allowed to do rather than what it returns.
 *
 * The two properties that matter most:
 *
 *  - **Configuring is not adopting.** Saving a destination writes nothing to the
 *    disk, so a path can be set (and refused if it is dangerous) without anything
 *    being created at it.
 *  - **Adoption is explicit and confirmed.** A disk carrying no marker is adopted
 *    silently because there is nothing to destroy. A disk carrying someone else's
 *    marker is refused unless the caller echoes back the exact id the status
 *    endpoint reported, which means a user confirmed what they were taking over
 *    and a disk swapped between the two requests cannot be adopted by accident.
 *
 * Mirrors the harness in libraryLocationResetRoute.test.ts: the real router on
 * plain express + apiEnvelope, driven over HTTP.
 */

let server: http.Server;
let baseUrl: string;
let currentRole = 'admin';

function scratchDir(prefix = 'nebulis-archiveroute-test-dest-'): string {
  return fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), prefix));
}

const created: string[] = [];
function makeDest(): string {
  const dir = scratchDir();
  created.push(dir);
  return dir;
}

/**
 * The success payload of every archive route. The envelope carries `data` on
 * success and `error` on failure, so callers assert `status` before reading
 * `data`; the failure-path assertions read `body.error` instead. `config` is
 * typed from the server's own interface rather than restated here, so a rename
 * cannot silently make this test pass against nothing.
 */
interface ArchiveStatusPayload {
  config: ArchiveConfig;
  destination: { state: string; path: string; foundArchiveId: string | null };
}

async function api<T = ArchiveStatusPayload>(
  method: string,
  routePath: string,
  body?: unknown,
): Promise<{ status: number; body: { ok?: boolean; data: T; error?: { code: string; message: string } } }> {
  const res = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await res.json()) as { ok?: boolean; data: T; error?: { code: string; message: string } };
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test';
    req.userId = 'u';
    req.username = 'tester';
    req.userRole = currentRole;
    next();
  });
  app.use('/', storageRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  currentRole = 'admin';
  // A full reset rather than a field list, so a new setting arrives here by default
  // instead of leaking in from whichever file ran first. The feature is switched ON
  // because these tests are about what the routes do; the master-switch cases at the
  // end of the file turn it off to prove what a disabled feature refuses.
  setArchiveConfig({
    ...DEFAULT_ARCHIVE_CONFIG,
    enabled: true,
    network: { ...DEFAULT_ARCHIVE_CONFIG.network, clearPassword: true },
  });
});

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET /storage/archive — status', () => {
  it('reports an unconfigured install without throwing', async () => {
    const { status, body } = await api('GET', '/archive');
    expect(status).toBe(200);
    expect(body.data.config.path).toBe('');
    expect(body.data.destination.state).toBe('unconfigured');
  });

  it('reports absent when a valid destination has no marker yet', async () => {
    const dest = makeDest();
    setArchiveConfig({ path: dest });
    const { body } = await api('GET', '/archive');
    expect(body.data.destination.state).toBe('absent');
  });

  it('writes nothing while reporting status', async () => {
    const dest = makeDest();
    setArchiveConfig({ path: dest, archiveId: 'our-id' });
    await api('GET', '/archive');
    expect(fs.readdirSync(dest)).toEqual([]);
    expect(getArchiveConfig().archiveId).toBe('our-id');
  });

  it('reports match once the configured id is the one on disk', async () => {
    const dest = makeDest();
    writeArchiveMarker(dest, 'our-id');
    setArchiveConfig({ path: dest, archiveId: 'our-id' });
    const { body } = await api('GET', '/archive');
    expect(body.data.destination.state).toBe('match');
  });

  it('flags a destination on the same disk as the library or data folder, without refusing it', async () => {
    // makeDest() sits beside DATA_DIR, so it is on the same device by construction.
    const dest = makeDest();
    setArchiveConfig({ path: dest, archiveId: 'our-id' });
    const { body } = await api('GET', '/archive');
    expect(body.data.destination.sameDiskAsLibrary).toBe(true);
    expect(body.data.destination.state).toBe('absent');
  });

  it('does not flag an unconfigured destination', async () => {
    const { body } = await api('GET', '/archive');
    expect(body.data.destination.sameDiskAsLibrary).toBe(false);
  });

  it('names the id it found on a foreign disk, so the UI can show it', async () => {
    const dest = makeDest();
    writeArchiveMarker(dest, 'someone-elses');
    setArchiveConfig({ path: dest, archiveId: 'our-id' });
    const { body } = await api('GET', '/archive');
    expect(body.data.destination.state).toBe('foreign');
    expect(body.data.destination.foundArchiveId).toBe('someone-elses');
  });

  it('flags a stored destination that is now forbidden', async () => {
    // Reachable if the database is edited by hand, or a future release tightens
    // the rules. The status has to say so rather than reporting a disk state.
    setArchiveConfig({ path: getLibraryDir() });
    const { body } = await api('GET', '/archive');
    expect(body.data.destination.state).toBe('invalid-path');
  });

  it('is readable without admin, like the other read-only storage routes', async () => {
    currentRole = 'viewer';
    const { status } = await api('GET', '/archive');
    expect(status).toBe(200);
  });
});

describe('PUT /storage/archive — saving configuration', () => {
  it('saves a valid destination and its scope', async () => {
    const dest = makeDest();
    const { status, body } = await api('PUT', '/archive', {
      path: dest,
      scope: 'selected',
      selectedObjects: ['M31'],
      includeSubframes: true,
      retentionDays: 30,
    });
    expect(status).toBe(200);
    expect(body.data.config.path).toBe(dest);
    const stored = getArchiveConfig();
    expect(stored.path).toBe(dest);
    expect(stored.selectedObjects).toEqual(['M31']);
    expect(stored.retentionDays).toBe(30);
  });

  it('writes nothing to the destination, because configuring is not adopting', async () => {
    const dest = makeDest();
    await api('PUT', '/archive', { path: dest });
    expect(fs.readdirSync(dest)).toEqual([]);
    expect(getArchiveConfig().archiveId).toBe('');
  });

  it('requires admin', async () => {
    currentRole = 'viewer';
    const { status } = await api('PUT', '/archive', { path: makeDest() });
    expect(status).toBe(403);
  });

  it('refuses the library directory and saves nothing', async () => {
    const { status, body } = await api('PUT', '/archive', { path: getLibraryDir() });
    expect(status).toBe(400);
    expect(body.error?.code).toBe('ARCHIVE_INVALID_DESTINATION');
    expect(getArchiveConfig().path).toBe('');
  });

  it('refuses DATA_DIR and an ancestor of it', async () => {
    for (const candidate of [DATA_DIR, path.dirname(path.resolve(DATA_DIR))]) {
      const { status, body } = await api('PUT', '/archive', { path: candidate });
      expect(status, `expected ${candidate} to be refused`).toBe(400);
      expect(body.error?.code).toBe('ARCHIVE_INVALID_DESTINATION');
    }
    expect(getArchiveConfig().path).toBe('');
  });

  it('refuses a relative path', async () => {
    const { status, body } = await api('PUT', '/archive', { path: 'relative/archive' });
    expect(status).toBe(400);
    expect(body.error?.code).toBe('ARCHIVE_INVALID_DESTINATION');
  });

  it('reports which field was invalid when the configuration is bad', async () => {
    const { status, body } = await api('PUT', '/archive', { scheduleHour: 99 });
    expect(status).toBe(400);
    expect(body.error?.code).toBe('ARCHIVE_INVALID_CONFIG');
    expect(body.error?.message).toMatch(/scheduleHour/);
  });

  it('saves nothing when any part of the patch is invalid', async () => {
    const dest = makeDest();
    const { status } = await api('PUT', '/archive', { path: dest, scheduleHour: 99 });
    expect(status).toBe(400);
    expect(getArchiveConfig().path).toBe('');
  });

  it('refuses a non-object body rather than coercing it', async () => {
    const { status } = await api('PUT', '/archive', [1, 2, 3]);
    expect(status).toBe(400);
  });
});

describe('POST /storage/archive/adopt — claiming a disk', () => {
  it('requires admin', async () => {
    currentRole = 'viewer';
    const { status } = await api('POST', '/archive/adopt', {});
    expect(status).toBe(403);
  });

  it('refuses when no destination is configured', async () => {
    const { status, body } = await api('POST', '/archive/adopt', {});
    expect(status).toBe(400);
    expect(body.error?.code).toBe('ARCHIVE_NO_DESTINATION');
  });

  it('adopts an empty disk: writes the marker and records the id', async () => {
    const dest = makeDest();
    setArchiveConfig({ path: dest });
    const { status, body } = await api('POST', '/archive/adopt', {});
    expect(status).toBe(200);
    expect(body.data.destination.state).toBe('match');

    const id = getArchiveConfig().archiveId;
    expect(id).not.toBe('');
    const marker = parseArchiveMarker(fs.readFileSync(path.join(dest, ARCHIVE_MARKER_FILENAME), 'utf8'));
    expect(marker?.archiveId).toBe(id);
  });

  it('refuses a foreign disk and names the id, leaving its marker untouched', async () => {
    const dest = makeDest();
    writeArchiveMarker(dest, 'someone-elses');
    setArchiveConfig({ path: dest, archiveId: 'our-id' });

    const { status, body } = await api('POST', '/archive/adopt', {});
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_FOREIGN_CONFIRMATION_REQUIRED');
    expect(body.error?.message).toContain('someone-elses');

    const marker = parseArchiveMarker(fs.readFileSync(path.join(dest, ARCHIVE_MARKER_FILENAME), 'utf8'));
    expect(marker?.archiveId).toBe('someone-elses');
    expect(getArchiveConfig().archiveId).toBe('our-id');
  });

  it('refuses a foreign disk when the confirmation names a different id', async () => {
    const dest = makeDest();
    writeArchiveMarker(dest, 'someone-elses');
    setArchiveConfig({ path: dest });

    const { status } = await api('POST', '/archive/adopt', { confirmArchiveId: 'not-what-is-there' });
    expect(status).toBe(409);
    const marker = parseArchiveMarker(fs.readFileSync(path.join(dest, ARCHIVE_MARKER_FILENAME), 'utf8'));
    expect(marker?.archiveId).toBe('someone-elses');
  });

  it('takes over a foreign disk when the confirmation echoes the id that was reported', async () => {
    const dest = makeDest();
    writeArchiveMarker(dest, 'someone-elses');
    setArchiveConfig({ path: dest });

    const { status, body } = await api('POST', '/archive/adopt', { confirmArchiveId: 'someone-elses' });
    expect(status).toBe(200);
    expect(body.data.destination.state).toBe('match');

    const id = getArchiveConfig().archiveId;
    expect(id).not.toBe('');
    expect(id).not.toBe('someone-elses');
    const marker = parseArchiveMarker(fs.readFileSync(path.join(dest, ARCHIVE_MARKER_FILENAME), 'utf8'));
    expect(marker?.archiveId).toBe(id);
  });

  it('refuses a marker it cannot read, and does not overwrite it', async () => {
    for (const setup of ['unreadable', 'invalid'] as const) {
      const dest = makeDest();
      if (setup === 'unreadable') {
        fs.mkdirSync(path.join(dest, ARCHIVE_MARKER_FILENAME));
      } else {
        fs.writeFileSync(path.join(dest, ARCHIVE_MARKER_FILENAME), 'garbage', 'utf8');
      }
      setArchiveConfig({ path: dest });

      const { status, body } = await api('POST', '/archive/adopt', {});
      expect(status, `${setup} marker`).toBe(409);
      expect(body.error?.code).toBe('ARCHIVE_MARKER_UNREADABLE');

      // Whatever was there is still there, byte for byte.
      const stat = fs.statSync(path.join(dest, ARCHIVE_MARKER_FILENAME));
      if (setup === 'unreadable') {
        expect(stat.isDirectory()).toBe(true);
      } else {
        expect(fs.readFileSync(path.join(dest, ARCHIVE_MARKER_FILENAME), 'utf8')).toBe('garbage');
      }
      expect(getArchiveConfig().archiveId).toBe('');
    }
  });

  it('refuses an adopt whose stored destination has become forbidden', async () => {
    setArchiveConfig({ path: getLibraryDir() });
    const { status, body } = await api('POST', '/archive/adopt', {});
    expect(status).toBe(400);
    expect(body.error?.code).toBe('ARCHIVE_INVALID_DESTINATION');
  });
});

/**
 * The master switch, from the outside.
 *
 * The settings page dims the section while this is off, and a dimmed section is only
 * a promise if the server keeps it. Every route that writes to the disk or deletes
 * from the library is checked here, including the one that adopts a disk and the one
 * that deletes from an archive, because those are the two that touch hardware.
 */
describe('the master switch — a disabled feature refuses to act', () => {
  beforeEach(() => {
    setArchiveConfig({ enabled: false });
  });

  it('refuses an adopt and leaves no marker behind', async () => {
    const dest = makeDest();
    setArchiveConfig({ path: dest });

    const { status, body } = await api('POST', '/archive/adopt', {});
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_DISABLED');
    expect(fs.readdirSync(dest)).toEqual([]);
    expect(getArchiveConfig().archiveId).toBe('');
  });

  it('refuses a run', async () => {
    const dest = makeDest();
    writeArchiveMarker(dest, 'our-id');
    setArchiveConfig({ path: dest, archiveId: 'our-id' });

    const { status, body } = await api('POST', '/archive/run', {});
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_DISABLED');
  });

  it('refuses a prune', async () => {
    const dest = makeDest();
    writeArchiveMarker(dest, 'our-id');
    setArchiveConfig({ path: dest, archiveId: 'our-id', retentionEnabled: true, retentionDays: 1 });

    const { status, body } = await api('POST', '/archive/retention/apply', {});
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_DISABLED');
  });

  it('refuses a restore', async () => {
    const dest = makeDest();
    writeArchiveMarker(dest, 'our-id');
    setArchiveConfig({ path: dest, archiveId: 'our-id' });

    const { status, body } = await api('POST', '/archive/restore', { items: [] });
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_DISABLED');
  });

  it('still reports the configuration and the destination, so the disabled section can render', async () => {
    const dest = makeDest();
    writeArchiveMarker(dest, 'our-id');
    setArchiveConfig({ path: dest, archiveId: 'our-id' });

    const { status, body } = await api('GET', '/archive');
    expect(status).toBe(200);
    expect(body.data.config.enabled).toBe(false);
    expect(body.data.config.path).toBe(dest);
    expect(body.data.destination.state).toBe('match');
  });
});

describe('POST /storage/archive/retention/apply — pruning that is switched off', () => {
  it('refuses while the retention switch is off, without deleting anything', async () => {
    const dest = makeDest();
    writeArchiveMarker(dest, 'our-id');
    setArchiveConfig({ path: dest, archiveId: 'our-id', retentionEnabled: false, retentionDays: 1 });

    const { status, body } = await api('POST', '/archive/retention/apply', {});
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_RETENTION_DISABLED');
    expect(fs.readdirSync(dest)).toEqual([ARCHIVE_MARKER_FILENAME]);
  });
});
