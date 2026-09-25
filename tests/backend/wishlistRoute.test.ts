import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR to a temp dir before any server module loads (db.ts
// captures it at import time). Same idiom as calibrationAttachRoutes.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-wishlistroute-test-'));
  _process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { wishlistRouter } from '../../server/routes/wishlist';
import db from '../../server/lib/db';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test-request';
    req.userId = 'test-user';
    req.userRole = 'admin';
    next();
  });
  app.use('/', wishlistRouter);

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM wishlist').run();
});

describe('POST /wishlist', () => {
  // Regression test: catalog entries that are missing a magnitude, an
  // angular size, or a constellation (common for clusters/nebulae) send an
  // explicit `null` for those fields, not an absent key. The route used to
  // 422 on that (`.optional()` alone only tolerates `undefined`), which
  // silently blocked adding those objects from the Planner's star button.
  it('accepts null magnitude, majorAxisArcmin, and constellation', async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objectId: 'NGC1579',
        name: 'NGC1579',
        type: 'Cluster + Nebula',
        constellation: null,
        magnitude: null,
        majorAxisArcmin: 10.2,
        priority: 'medium',
        notes: '',
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      objectId: 'NGC1579',
      constellation: null,
      magnitude: null,
      majorAxisArcmin: 10.2,
    });
  });

  it('still accepts these fields being entirely absent', async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objectId: 'M42', name: 'Orion Nebula' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ objectId: 'M42', constellation: null, magnitude: null, majorAxisArcmin: null });
  });
});
