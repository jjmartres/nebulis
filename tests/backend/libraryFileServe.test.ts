import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-fileserve-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import { getLibraryDir } from '../../server/lib/libraryPath';

// GET /file is served without a credential, so it streams from disk instead of
// buffering the file, and must keep refusing anything outside the library root.
let server: http.Server;
let baseUrl: string;
const BYTES = Buffer.from('not-really-a-jpeg-but-bytes-are-bytes');

beforeAll(async () => {
  const objDir = path.join(getLibraryDir(), 'M42');
  fs.mkdirSync(objDir, { recursive: true });
  fs.writeFileSync(path.join(objDir, 'Stacked_M42.jpg'), BYTES);
  fs.writeFileSync(path.join(TEST_DATA_DIR, 'secret.jpg'), 'outside');

  const app = express();
  app.use(apiEnvelope);
  app.use((req, _res, next) => { req.userRole = 'admin'; next(); });
  app.use('/', libraryRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('GET /file', () => {
  it('streams a library image with its mime type', async () => {
    const res = await fetch(`${baseUrl}/file?path=${encodeURIComponent('M42/Stacked_M42.jpg')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);
  });

  it('404s a missing file', async () => {
    const res = await fetch(`${baseUrl}/file?path=${encodeURIComponent('M42/nope.jpg')}`);
    expect(res.status).toBe(404);
  });

  it('refuses a path that climbs out of the library', async () => {
    const res = await fetch(`${baseUrl}/file?path=${encodeURIComponent('../secret.jpg')}`);
    expect(res.status).toBe(404);
  });
});
