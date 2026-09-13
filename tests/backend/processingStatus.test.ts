import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR before any server module loads (paths.ts captures it at
// import time). Same pattern as routeDecoding.test.ts / objectTypeOverride.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-processingstatus-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import { stmts, getLocalObjects, setProcessingStatus } from '../../server/lib/library/objects';

const OBJECT_ID = 'M42';

function seedObject(overrides: { deleted?: 0 | 1 } = {}): void {
  stmts.upsertObject.run(
    OBJECT_ID, OBJECT_ID, 0, new Date().toISOString(), overrides.deleted ?? 0, null,
    null, null, null, null, null, null, null, null, null,
  );
  // upsertObject's ON CONFLICT clause never touches processingStatus (see its
  // own column list), so a value a previous test set would otherwise leak
  // across tests via this shared row. Reset explicitly rather than relying
  // on the column default, which only applies to a brand-new row.
  setProcessingStatus(OBJECT_ID, 'unprocessed');
}

// ─── Unit-level: the domain function + its effect on getLocalObjects ───────

describe('setProcessingStatus (unit)', () => {
  beforeEach(() => {
    seedObject();
  });

  it('defaults a freshly-seeded object to unprocessed', () => {
    expect(getLocalObjects('').find(o => o.id === OBJECT_ID)?.processingStatus).toBe('unprocessed');
  });

  it('persists a new status and reports it back via getLocalObjects', () => {
    expect(setProcessingStatus(OBJECT_ID, 'processing')).toBe(true);
    expect(getLocalObjects('').find(o => o.id === OBJECT_ID)?.processingStatus).toBe('processing');

    expect(setProcessingStatus(OBJECT_ID, 'processed')).toBe(true);
    expect(getLocalObjects('').find(o => o.id === OBJECT_ID)?.processingStatus).toBe('processed');

    expect(setProcessingStatus(OBJECT_ID, 'unprocessed')).toBe(true);
    expect(getLocalObjects('').find(o => o.id === OBJECT_ID)?.processingStatus).toBe('unprocessed');
  });

  it('reports false for an id that matches no live row', () => {
    expect(setProcessingStatus('NOT-IN-LIBRARY-1234', 'processing')).toBe(false);
  });

  it('reports false for a tombstoned (deleted) object — matches the read side, which already hides it', () => {
    seedObject({ deleted: 1 });
    expect(setProcessingStatus(OBJECT_ID, 'processing')).toBe(false);
  });
});

// ─── Route-level: PUT /objects/:objectId/processing-status ─────────────────

let adminServer: http.Server;
let adminBaseUrl: string;
let viewerServer: http.Server;
let viewerBaseUrl: string;

function buildApp(role: 'admin' | 'viewer') {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test-request';
    req.userId = 'test-user';
    req.userRole = role;
    next();
  });
  app.use('/', libraryRouter);
  return app;
}

beforeAll(async () => {
  adminServer = http.createServer(buildApp('admin'));
  await new Promise<void>(resolve => adminServer.listen(0, resolve));
  adminBaseUrl = `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`;

  viewerServer = http.createServer(buildApp('viewer'));
  await new Promise<void>(resolve => viewerServer.listen(0, resolve));
  viewerBaseUrl = `http://127.0.0.1:${(viewerServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => adminServer.close(() => resolve()));
  await new Promise<void>(resolve => viewerServer.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  seedObject();
});

describe('PUT /objects/:objectId/processing-status', () => {
  it('updates the status and echoes it back', async () => {
    const res = await fetch(`${adminBaseUrl}/objects/${OBJECT_ID}/processing-status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'processing' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ objectId: OBJECT_ID, processingStatus: 'processing' });
    expect(getLocalObjects('').find(o => o.id === OBJECT_ID)?.processingStatus).toBe('processing');
  });

  it('rejects a value outside the three-state enum', async () => {
    const res = await fetch(`${adminBaseUrl}/objects/${OBJECT_ID}/processing-status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'finished' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('BAD_REQUEST');
    // Unchanged.
    expect(getLocalObjects('').find(o => o.id === OBJECT_ID)?.processingStatus).toBe('unprocessed');
  });

  it('returns 404 for an object id that does not exist', async () => {
    const res = await fetch(`${adminBaseUrl}/objects/NOT-IN-LIBRARY-1234/processing-status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'processed' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('requires admin — a viewer gets 403 and the row is left untouched', async () => {
    const res = await fetch(`${viewerBaseUrl}/objects/${OBJECT_ID}/processing-status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'processed' }),
    });
    expect(res.status).toBe(403);
    expect(getLocalObjects('').find(o => o.id === OBJECT_ID)?.processingStatus).toBe('unprocessed');
  });
});
