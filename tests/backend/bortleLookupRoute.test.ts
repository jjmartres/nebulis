/* eslint-disable @typescript-eslint/no-require-imports --
   `vi.hoisted` runs before the ESM imports are evaluated, which is the only way
   to point DATA_DIR at a scratch directory before server/lib/paths.ts reads it
   at module load. Same idiom as libraryLocationResetRoute.test.ts; the require
   calls are Node builtins inside that hoisted block, nowhere else. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Isolated DATA_DIR, set before any server module loads (see
// libraryLocationResetRoute.test.ts, which this pattern comes from).
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-bortle-'));
  _process.env.DATA_DIR = dir;
  _process.env.DATA_KEY = Buffer.alloc(32, 5).toString('base64');
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { sitesRouter } from '../../server/routes/sites';
import { createSite, deleteSite, listSites } from '../../server/lib/observingSites';

let server: http.Server;
let baseUrl: string;
let role = 'admin';

/** Captured before any test stubs `fetch`: the helper below has to reach the
 *  test server over the real network while the route under test is stubbed. */
const realFetch = globalThis.fetch;

/** Distinct coordinates per test: the route caches by coordinate, so sharing
 *  them would make one test's cache hit another test's assertion. */
function makeSite(lat: number | null, lon: number | null): string {
  return createSite({ name: `Site ${lat},${lon}`, latitude: lat, longitude: lon }).id;
}

function okPayload(bortleClass: unknown, sqm: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ payload: { metrics: { bortleClass, sqm } } }),
  } as unknown as Response;
}

async function lookup(id: string, fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const res = await realFetch(`${baseUrl}/sites/${id}/bortle-lookup`, { method: 'POST' });
  return { status: res.status, body: await res.json() as { ok: boolean; data: { bortleClass: number; sqm: number; source: string } | null; error: { code: string; message: string } | null } };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test';
    req.userId = 'u';
    req.username = 'tester';
    req.userRole = role;
    next();
  });
  app.use('/sites', sitesRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => resolve()); });
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  role = 'admin';
  for (const s of listSites()) deleteSite(s.id);
  vi.unstubAllGlobals();
});

describe('POST /sites/:id/bortle-lookup', () => {
  it('returns the class and SQM from the upstream service', async () => {
    const id = makeSite(40.1111, -105.2222);
    const mock = vi.fn().mockResolvedValue(okPayload(4, 21.5));
    const { status, body } = await lookup(id, mock);

    expect(status).toBe(200);
    expect(body.data).toEqual({ bortleClass: 4, sqm: 21.5, source: 'live' });

    // The coordinates went out as numbers, and only our own host was called.
    const url = String(mock.mock.calls[0][0]);
    expect(url).toContain('darkskysites.com');
    expect(url).toContain('lat=40.111100');
    expect(url).toContain('lng=-105.222200');
  });

  it('serves the second lookup from cache without calling out again', async () => {
    const id = makeSite(41.5, -106.5);
    const mock = vi.fn().mockResolvedValue(okPayload(6, 19.8));

    const first = await lookup(id, mock);
    const second = await lookup(id, mock);

    expect(first.body.data?.source).toBe('live');
    expect(second.body.data?.source).toBe('cache');
    expect(second.body.data?.bortleClass).toBe(6);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('rejects an out-of-range class rather than caching it', async () => {
    // The site schema accepts 1-9, and the client writes this back through
    // PUT /sites/:id, so a 12 here would surface later as a 422.
    const id = makeSite(42.5, -107.5);
    const mock = vi.fn().mockResolvedValue(okPayload(12, 21));
    const { status, body } = await lookup(id, mock);

    expect(status).toBe(502);
    expect(body.error?.code).toBe('UPSTREAM_ERROR');

    // Not cached: a later good answer still reaches the service.
    const good = vi.fn().mockResolvedValue(okPayload(5, 20.4));
    const retry = await lookup(id, good);
    expect(retry.body.data?.source).toBe('live');
  });

  it('rejects a non-numeric SQM', async () => {
    const id = makeSite(43.5, -108.5);
    const { status } = await lookup(id, vi.fn().mockResolvedValue(okPayload(4, 'bright')));
    expect(status).toBe(502);
  });

  it('reports an upstream failure without echoing its message', async () => {
    const id = makeSite(44.5, -109.5);
    const mock = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND internal.host.local'));
    const { status, body } = await lookup(id, mock);

    expect(status).toBe(502);
    expect(body.error?.code).toBe('UPSTREAM_ERROR');
    // The host name must not reach the client.
    expect(body.error?.message ?? '').not.toContain('internal.host.local');
    expect(body.error?.message ?? '').not.toContain('ENOTFOUND');
  });

  it('passes on a non-OK upstream status as 502', async () => {
    const id = makeSite(45.5, -110.5);
    const mock = vi.fn().mockResolvedValue({ ok: false, status: 503 } as unknown as Response);
    const { status, body } = await lookup(id, mock);
    expect(status).toBe(502);
    expect(body.error?.message ?? '').not.toContain('503');
  });

  it('refuses a site with no coordinates, without calling out', async () => {
    const id = makeSite(null, null);
    const mock = vi.fn();
    const { status, body } = await lookup(id, mock);

    expect(status).toBe(400);
    expect(body.error?.code).toBe('NO_COORDINATES');
    expect(mock).not.toHaveBeenCalled();
  });

  it('refuses an unknown site', async () => {
    const mock = vi.fn();
    const { status, body } = await lookup('does-not-exist', mock);
    expect(status).toBe(404);
    expect(body.error?.code).toBe('NOT_FOUND');
    expect(mock).not.toHaveBeenCalled();
  });

  it('is admin-only, and a viewer never triggers the outbound call', async () => {
    const id = makeSite(46.5, -111.5);
    role = 'viewer';
    const mock = vi.fn();
    const { status, body } = await lookup(id, mock);

    expect(status).toBe(403);
    expect(body.error?.code).toBe('FORBIDDEN');
    expect(mock).not.toHaveBeenCalled();
  });
});
