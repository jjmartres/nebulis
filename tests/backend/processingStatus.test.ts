import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR before any server module loads (paths.ts captures it at
// import time). Same pattern as calibrationAttachRoutes.test.ts.
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
import db from '../../server/lib/db';
import { stmts, getLocalObjects, setProcessingStatus } from '../../server/lib/library/objects';

const OBJECT_ID = 'M42';

function seedObject(): void {
  db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(OBJECT_ID);
  stmts.upsertObject.run(
    OBJECT_ID, OBJECT_ID, 0, new Date().toISOString(), 0, null,
    null, null, null, null, null, null, null, null, null,
  );
}

describe('setProcessingStatus (unit)', () => {
  beforeEach(() => {
    seedObject();
  });

  it('defaults a freshly-seeded object to unprocessed', () => {
    expect(getLocalObjects('').find(o => o.id === OBJECT_ID)?.processingStatus).toBe('unprocessed');
  });

  it('round-trips through every status', () => {
    for (const status of ['processing', 'processed', 'unprocessed'] as const) {
      expect(setProcessingStatus(OBJECT_ID, status)).toBe(true);
      expect(getLocalObjects('').find(o => o.id === OBJECT_ID)?.processingStatus).toBe(status);
    }
  });

  it('no-ops on an unknown object id', () => {
    expect(setProcessingStatus('NOT-A-REAL-OBJECT', 'processed')).toBe(false);
  });

  it('no-ops on a tombstoned object', () => {
    stmts.markObjectDeleted.run(new Date().toISOString(), OBJECT_ID);
    expect(setProcessingStatus(OBJECT_ID, 'processed')).toBe(false);
  });
});

describe('PUT /objects/:objectId/processing-status (route)', () => {
  let server: http.Server;
  let baseUrl: string;
  let userRole = 'admin';

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(apiEnvelope);
    app.use((req, _res, next) => {
      req.id = 'test-request';
      req.userId = 'test-user';
      req.userRole = userRole;
      next();
    });
    app.use('/', libraryRouter);

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
    userRole = 'admin';
    seedObject();
  });

  it('sets the status and echoes it back', async () => {
    const res = await fetch(`${baseUrl}/objects/${OBJECT_ID}/processing-status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'processing' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ objectId: OBJECT_ID, processingStatus: 'processing' });
    expect(getLocalObjects('').find(o => o.id === OBJECT_ID)?.processingStatus).toBe('processing');
  });

  it('400s on an out-of-enum status value', async () => {
    const res = await fetch(`${baseUrl}/objects/${OBJECT_ID}/processing-status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'not-a-real-status' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s on a nonexistent object id', async () => {
    const res = await fetch(`${baseUrl}/objects/NOT-A-REAL-OBJECT/processing-status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'processed' }),
    });
    expect(res.status).toBe(404);
  });

  it('403s for a viewer', async () => {
    userRole = 'viewer';
    const res = await fetch(`${baseUrl}/objects/${OBJECT_ID}/processing-status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'processed' }),
    });
    expect(res.status).toBe(403);
  });
});
