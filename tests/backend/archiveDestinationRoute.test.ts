import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR before any server module loads: the archive's mount directory is
// derived from it at import time.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-archive-dest-route-'));
  _process.env.DATA_DIR = dir;
  _process.env.DATA_KEY = Buffer.alloc(32, 5).toString('base64');
  return dir;
});

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: string; stderr: string }) => void;
    Promise.resolve(execFileMock(...args.slice(0, -1))).then(
      result => cb(null, (result as { stdout: string; stderr: string }) ?? { stdout: '', stderr: '' }),
      err => cb(err instanceof Error ? err : new Error(String(err))),
    );
  },
}));

const tcpProbeMock = vi.fn();
vi.mock('../../server/lib/smbReachability', () => ({
  tcpProbe: (...args: unknown[]) => tcpProbeMock(...args),
  SMB_PORT: 445,
}));

import fs from 'fs';
import path from 'path';

import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { storageRouter, invalidateArchiveDestinationView } from '../../server/routes/storage';
import {
  ARCHIVE_NETWORK_MOUNT_DIR,
  disconnectArchiveNetwork,
  invalidateArchiveReachability,
} from '../../server/lib/archive/archiveNetwork';
import { ARCHIVE_MARKER_FILENAME, parseArchiveMarker } from '../../server/lib/archive/archiveMarker';
import {
  DEFAULT_ARCHIVE_CONFIG,
  getArchiveConfig,
  setArchiveConfig,
  type ArchiveConfig,
  type ArchiveNetworkConfig,
} from '../../server/lib/archive/archiveConfig';

/**
 * The destination routes: testing a share, saving one, and browsing it.
 *
 * Three properties are what this file is for.
 *
 *  - **A password goes in and never comes out.** Not through the config payload, not
 *    through a status read, not through a failure message. The config type has no
 *    field for one, and these tests assert the serialised payloads do not contain it
 *    either.
 *  - **A share that is not mounted is its own state.** It reports `offline`, not
 *    `absent`, because `absent` is what the UI offers to adopt and the mount directory
 *    is an ordinary empty folder underneath.
 *  - **Browsing cannot leave the share.** The route exists so the picker can offer
 *    folders; it must not become an admin-only way to read the machine's filesystem.
 *
 * The harness mirrors `archiveRoute.test.ts`: the real router on plain express with
 * the response envelope, driven over HTTP.
 */

const SUBPATH = 'Nebulis-Archive';
const SUBPATH_ROOT = path.join(ARCHIVE_NETWORK_MOUNT_DIR, SUBPATH);

let server: http.Server;
let baseUrl: string;
let currentRole = 'admin';

interface ArchiveStatusPayload {
  config: ArchiveConfig;
  destination: {
    state: string;
    path: string;
    foundArchiveId: string | null;
    locationType: string;
    network: ArchiveNetworkConfig;
    networkSupported: boolean;
  };
}

interface ApiResult<T> {
  status: number;
  body: { ok?: boolean; data: T; error?: { code: string; message: string } };
}

async function api<T = ArchiveStatusPayload>(
  method: string,
  routePath: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const res = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await res.json()) as ApiResult<T>['body'];
  return { status: res.status, body: parsed };
}

function network(overrides: Partial<ArchiveNetworkConfig & { password?: string }> = {}) {
  return { host: 'nas.local', share: 'Archive', domain: '', username: 'alice', subpath: SUBPATH, ...overrides };
}

/** The fake share is mounted or it is not, and the mount table is the only thing
 *  that decides. Nothing else in the module is mocked, so the real path building,
 *  marker reading and containment all run. */
function setMounted(mounted: boolean): void {
  execFileMock.mockImplementation((cmd: string) => {
    if (cmd === 'mount') {
      return Promise.resolve({
        stdout: mounted ? `//alice@nas.local/Archive on ${ARCHIVE_NETWORK_MOUNT_DIR} (smbfs, nodev, nosuid)` : '',
      });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  });
  tcpProbeMock.mockResolvedValue(5);
}

function resetConfig(): void {
  setArchiveConfig({
    ...DEFAULT_ARCHIVE_CONFIG,
    network: { ...DEFAULT_ARCHIVE_CONFIG.network, clearPassword: true },
  });
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
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  resetConfig();
  invalidateArchiveReachability();
  // The passive-read cache in storage.ts (GET /storage/archive) would otherwise
  // carry the previous test's result forward: every test in this file configures
  // the same host/share, well within that cache's TTL of real test run times.
  invalidateArchiveDestinationView();
  fs.rmSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true, force: true });
  fs.mkdirSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true });
  setMounted(false);
});

afterEach(() => {
  fs.rmSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true, force: true });
  execFileMock.mockReset();
  tcpProbeMock.mockReset();
});

describe('POST /storage/archive/destination/test', () => {
  it('requires admin', async () => {
    currentRole = 'viewer';
    const { status } = await api('POST', '/archive/destination/test', { network: network() });
    expect(status).toBe(403);
  });

  it('refuses a body with no network object', async () => {
    const { status, body } = await api('POST', '/archive/destination/test', {});
    expect(status).toBe(400);
    expect(body.error?.code).toBe('ARCHIVE_INVALID_CONFIG');
  });

  it('reports why an unreachable server is unreachable', async () => {
    tcpProbeMock.mockResolvedValue(null);
    const { status, body } = await api<{ ok: boolean; reason: string }>('POST', '/archive/destination/test', {
      network: network(),
    });

    expect(status).toBe(200);
    expect(body.data.ok).toBe(false);
    expect(body.data.reason).toContain('nas.local');
  });

  it('succeeds against a mounted share, and writes nothing on the server', async () => {
    setMounted(true);
    const before = getArchiveConfig();

    const { body } = await api<{ ok: boolean; reason: string | null }>('POST', '/archive/destination/test', {
      network: network({ password: 'hunter2' }),
    });

    expect(body.data.ok).toBe(true);
    // Testing is not saving: nothing about the destination changed, and the password
    // the test used was not stored.
    expect(getArchiveConfig()).toEqual(before);
    expect(getArchiveConfig().network.hasPassword).toBe(false);
  });

  it('does not fall back to the stored password when the client says it means none', async () => {
    // A fake share that only mounts when the password is in the URL, so the two
    // answers are distinguishable rather than both succeeding against a permissive mock.
    await disconnectArchiveNetwork();
    setArchiveConfig({ network: { ...network(), password: 'hunter2' } });
    let mounted = false;
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'mount') {
        return Promise.resolve({
          stdout: mounted ? `//alice@nas.local/Archive on ${ARCHIVE_NETWORK_MOUNT_DIR} (smbfs)` : '',
        });
      }
      if (cmd === 'mount_smbfs') {
        if (!String(args[0]).includes('hunter2@')) {
          return Promise.reject(Object.assign(new Error('exit 77'), { stderr: 'Authentication error' }));
        }
        mounted = true;
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    tcpProbeMock.mockResolvedValue(5);
    fs.mkdirSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true });

    // Keeping the stored password: the share mounts.
    const kept = await api<{ ok: boolean }>('POST', '/archive/destination/test', { network: network() });
    expect(kept.body.data.ok).toBe(true);

    // Asking for no password: the same share must now fail rather than quietly use it.
    mounted = false;
    const cleared = await api<{ ok: boolean; reason: string | null }>('POST', '/archive/destination/test', {
      network: { ...network(), password: '', clearPassword: true },
    });
    expect(cleared.body.data.ok).toBe(false);
    expect(cleared.body.data.reason).toMatch(/Authentication failed/);
  });

  it('never returns the password it was given', async () => {
    setMounted(true);
    const { body } = await api('POST', '/archive/destination/test', { network: network({ password: 'hunter2' }) });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('falls back to the stored password when the request omits one', async () => {
    // Otherwise testing a share you already configured would mean retyping a password
    // the server already holds. Asserted through behaviour rather than by reading the
    // command line: the fake share refuses to mount without that password, and is
    // mounted once it sees it.
    await disconnectArchiveNetwork();
    setArchiveConfig({ network: { ...network(), password: 'hunter2' } });

    let mounted = false;
    let sawStoredPassword = false;
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'mount') {
        return Promise.resolve({
          stdout: mounted ? `//alice@nas.local/Archive on ${ARCHIVE_NETWORK_MOUNT_DIR} (smbfs)` : '',
        });
      }
      if (cmd === 'mount_smbfs') {
        sawStoredPassword = String(args[0]).includes('hunter2@');
        if (!sawStoredPassword) {
          return Promise.reject(Object.assign(new Error('exit 77'), { stderr: 'Authentication error' }));
        }
        mounted = true;
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    tcpProbeMock.mockResolvedValue(5);
    fs.mkdirSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true });

    const { body } = await api<{ ok: boolean; reason: string | null }>('POST', '/archive/destination/test', {
      network: network(),
    });

    expect(sawStoredPassword).toBe(true);
    expect(body.data.ok).toBe(true);
  });
});

describe('PUT /storage/archive — a network destination', () => {
  it('requires admin', async () => {
    currentRole = 'viewer';
    const { status } = await api('PUT', '/archive', { locationType: 'network', network: network() });
    expect(status).toBe(403);
  });

  it('saves the share and reports it without the password', async () => {
    const { status, body } = await api('PUT', '/archive', {
      locationType: 'network',
      network: network({ password: 'hunter2' }),
    });

    expect(status).toBe(200);
    expect(body.data.config.locationType).toBe('network');
    expect(body.data.config.network.host).toBe('nas.local');
    expect(body.data.config.network.subpath).toBe(SUBPATH);
    expect(body.data.config.network.hasPassword).toBe(true);
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('refuses a network destination with no share, and stores nothing', async () => {
    const { status, body } = await api('PUT', '/archive', { locationType: 'network', network: { host: 'nas.local' } });

    expect(status).toBe(400);
    expect(body.error?.code).toBe('ARCHIVE_INVALID_CONFIG');
    expect(getArchiveConfig().locationType).toBe('local');
  });

  it('refuses a subpath that climbs out of the share', async () => {
    const { status } = await api('PUT', '/archive', {
      locationType: 'network',
      network: network({ subpath: '../../etc' }),
    });
    expect(status).toBe(400);
  });

  it('still refuses a local path overlapping the library', async () => {
    // The network branch must not have loosened the rule it sits beside.
    const { status, body } = await api('PUT', '/archive', { path: TEST_DATA_DIR });
    expect(status).toBe(400);
    expect(body.error?.code).toBe('ARCHIVE_INVALID_DESTINATION');
  });
});

describe('GET /storage/archive — a network destination', () => {
  beforeEach(() => {
    setArchiveConfig({ locationType: 'network', network: network({ password: 'hunter2' }) });
  });

  it('reports offline rather than absent when the share is not mounted', async () => {
    const { body } = await api('GET', '/archive');

    // The distinction is the point: `absent` is what the settings page offers to
    // adopt, and the mount directory is an empty local folder underneath.
    expect(body.data.destination.state).toBe('offline');
    expect(body.data.destination.locationType).toBe('network');
    expect(body.data.destination.networkSupported).toBe(true);
  });

  it('shows the share the user configured, not the directory it mounts at', async () => {
    const { body } = await api('GET', '/archive');
    expect(body.data.destination.path).toBe(`\\\\nas.local\\Archive\\${SUBPATH}`);
    expect(body.data.destination.path).not.toContain(TEST_DATA_DIR);
  });

  it('reports absent once the share is mounted and the folder has no marker', async () => {
    setMounted(true);
    fs.mkdirSync(SUBPATH_ROOT, { recursive: true });

    const { body } = await api('GET', '/archive');
    expect(body.data.destination.state).toBe('absent');
  });

  it('never puts a password in its payload', async () => {
    const { body } = await api('GET', '/archive');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(body.data.config.network.hasPassword).toBe(true);
  });

  it('reports that a share cannot be mounted at all on a platform that cannot do it', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { body } = await api('GET', '/archive');
    expect(body.data.destination.networkSupported).toBe(false);
    expect(body.data.destination.state).toBe('offline');
  });
});

/**
 * A passive GET is what the settings page fires every time it is opened, and
 * answering it accurately means actually mounting the share. `mount_smbfs`/`net use`
 * against a share that is not really there does not fail instantly, so doing that on
 * every page view is the settings page's own slow-load bug. These tests are about the
 * fix: a passive read reuses a recent result, and a real action (a save) is what
 * refreshes it, never a passive read itself.
 */
describe('GET /storage/archive — reusing a recent connection check', () => {
  beforeEach(() => {
    setArchiveConfig({ locationType: 'network', network: network({ password: 'hunter2' }) });
  });

  it('does not repeat the connect attempt on a second passive read', async () => {
    const first = await api('GET', '/archive');
    expect(first.body.data.destination.state).toBe('offline');
    expect(execFileMock.mock.calls.some(call => call[0] === 'mount')).toBe(true);

    execFileMock.mockClear();
    const second = await api('GET', '/archive');

    expect(second.body.data.destination.state).toBe('offline');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('does not notice the share coming online from a passive read alone, but a save does', async () => {
    expect((await api('GET', '/archive')).body.data.destination.state).toBe('offline');

    // The share is mounted now, but nothing has taken an action that would
    // re-check for real, so the cached "offline" is still what a passive read
    // reuses — that is exactly the cost this cache exists to avoid paying twice.
    setMounted(true);
    fs.mkdirSync(SUBPATH_ROOT, { recursive: true });
    expect((await api('GET', '/archive')).body.data.destination.state).toBe('offline');

    // Saving is a deliberate action, not a passive read, so it always checks for
    // real, and that fresh answer is what the very next passive read reuses.
    await api('PUT', '/archive', { locationType: 'network', network: network({ password: 'hunter2' }) });
    expect((await api('GET', '/archive')).body.data.destination.state).toBe('absent');
  });

  it('checks again once the cached result is old enough', async () => {
    expect((await api('GET', '/archive')).body.data.destination.state).toBe('offline');

    setMounted(true);
    fs.mkdirSync(SUBPATH_ROOT, { recursive: true });
    // Only Date.now() is mocked, not the timer/event-loop machinery a real HTTP
    // request over loopback still needs: the cache's own clock is what has to move,
    // not wall time itself.
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 21_000);
    try {
      expect((await api('GET', '/archive')).body.data.destination.state).toBe('absent');
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('POST /storage/archive/adopt — a network destination', () => {
  beforeEach(() => {
    // Adopting is behind the master switch, and these cases are about the destination
    // rather than the switch, so the feature is on.
    setArchiveConfig({ enabled: true, locationType: 'network', network: network() });
  });

  it('refuses while the share is not mounted, and writes nothing', async () => {
    const { status, body } = await api('POST', '/archive/adopt', { createFolder: true });

    expect(status).toBe(400);
    expect(body.error?.code).toBe('ARCHIVE_DESTINATION_UNUSABLE');
    // Not even the folder it would have created: an unmounted share's directory is a
    // local folder, and creating anything in it is the accident being prevented.
    expect(fs.existsSync(SUBPATH_ROOT)).toBe(false);
    expect(fs.readdirSync(ARCHIVE_NETWORK_MOUNT_DIR)).toEqual([]);
  });

  it('refuses a folder that does not exist when it is not asked to create one', async () => {
    setMounted(true);
    const { status, body } = await api('POST', '/archive/adopt', {});

    expect(status).toBe(400);
    expect(body.error?.code).toBe('ARCHIVE_DESTINATION_MISSING');
  });

  it('creates the folder when asked, then adopts it', async () => {
    setMounted(true);
    const { status } = await api('POST', '/archive/adopt', { createFolder: true });
    expect(status).toBe(200);

    const marker = parseArchiveMarker(fs.readFileSync(path.join(SUBPATH_ROOT, ARCHIVE_MARKER_FILENAME), 'utf8'));
    expect(marker?.archiveId).toBe(getArchiveConfig().archiveId);

    const { body } = await api('GET', '/archive');
    expect(body.data.destination.state).toBe('match');
  });

  it('adopts an existing empty folder without being asked to create it', async () => {
    setMounted(true);
    fs.mkdirSync(SUBPATH_ROOT, { recursive: true });

    const { status } = await api('POST', '/archive/adopt', {});
    expect(status).toBe(200);
    expect(fs.existsSync(path.join(SUBPATH_ROOT, ARCHIVE_MARKER_FILENAME))).toBe(true);
  });
});

describe('POST /storage/archive/destination/browse', () => {
  it('requires admin', async () => {
    currentRole = 'viewer';
    const { status } = await api('POST', '/archive/destination/browse', {});
    expect(status).toBe(403);
  });

  it('refuses when the destination is not a network share and no share was offered', async () => {
    const { status, body } = await api('POST', '/archive/destination/browse', {});
    expect(status).toBe(400);
    expect(body.error?.code).toBe('ARCHIVE_NOT_NETWORK');
  });

  it('browses a share the user has typed but not saved', async () => {
    // The first-time case, and the one the picker needs: nothing is saved yet, so
    // reading the saved destination would refuse. The typed share is what gets
    // connected and listed, and nothing is written to the configuration.
    setMounted(true);
    fs.mkdirSync(path.join(ARCHIVE_NETWORK_MOUNT_DIR, 'Alpha'), { recursive: true });

    // A host the fake mount table does not already name, so an inherited mount
    // cannot be adopted: connecting this must actually mount the candidate.
    const { status, body } = await api<{ root: string; directories: Array<{ name: string }> }>(
      'POST',
      '/archive/destination/browse',
      { network: network({ host: 'other.local', password: 'hunter2' }) },
    );

    expect(status).toBe(200);
    expect(body.data.directories.map(d => d.name)).toEqual(['Alpha']);
    expect(getArchiveConfig().locationType).toBe('local');
    expect(getArchiveConfig().network.host).toBe('');

    const mountCall = execFileMock.mock.calls.find(call => call[0] === 'mount_smbfs');
    expect((mountCall?.[1] as string[])[0]).toContain('other.local');
  });

  it('refuses a typed share whose subpath could not be used, without connecting', async () => {
    const { status, body } = await api('POST', '/archive/destination/browse', {
      network: network({ subpath: '../../etc' }),
    });
    expect(status).toBe(400);
    expect(body.error?.code).toBe('ARCHIVE_INVALID_DESTINATION');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('refuses while the share is not mounted', async () => {
    setArchiveConfig({ locationType: 'network', network: network() });
    const { status, body } = await api('POST', '/archive/destination/browse', {});
    expect(status).toBe(503);
    expect(body.error?.code).toBe('ARCHIVE_DESTINATION_UNUSABLE');
  });

  it('refuses a typed share it cannot connect to, rather than listing nothing', async () => {
    const { status, body } = await api('POST', '/archive/destination/browse', { network: network() });
    expect(status).toBe(503);
    expect(body.error?.code).toBe('ARCHIVE_DESTINATION_UNUSABLE');
  });

  it('lists the folders of a mounted share', async () => {
    setArchiveConfig({ locationType: 'network', network: network() });
    setMounted(true);
    fs.mkdirSync(path.join(ARCHIVE_NETWORK_MOUNT_DIR, 'Alpha'), { recursive: true });
    fs.mkdirSync(path.join(ARCHIVE_NETWORK_MOUNT_DIR, 'Beta'), { recursive: true });

    const { status, body } = await api<{ path: string; directories: Array<{ name: string }> }>(
      'POST',
      '/archive/destination/browse',
      {},
    );

    expect(status).toBe(200);
    expect(body.data.directories.map(d => d.name)).toEqual(['Alpha', 'Beta']);
  });

  it('refuses a path outside the share, however it is spelled', async () => {
    setArchiveConfig({ locationType: 'network', network: network() });
    setMounted(true);

    for (const outside of ['/etc', path.dirname(ARCHIVE_NETWORK_MOUNT_DIR), `${ARCHIVE_NETWORK_MOUNT_DIR}/../..`]) {
      const { status, body } = await api('POST', '/archive/destination/browse', { path: outside });
      expect(status, outside).toBe(400);
      expect(body.error?.code, outside).toBe('ARCHIVE_PATH_OUTSIDE_SHARE');
    }
  });

  it('walks down into a folder inside the share', async () => {
    setArchiveConfig({ locationType: 'network', network: network() });
    setMounted(true);
    fs.mkdirSync(path.join(ARCHIVE_NETWORK_MOUNT_DIR, 'Alpha', 'Nested'), { recursive: true });

    const { status, body } = await api<{ directories: Array<{ name: string }> }>(
      'POST',
      '/archive/destination/browse',
      { path: path.join(ARCHIVE_NETWORK_MOUNT_DIR, 'Alpha') },
    );

    expect(status).toBe(200);
    expect(body.data.directories.map(d => d.name)).toEqual(['Nested']);
  });
});
