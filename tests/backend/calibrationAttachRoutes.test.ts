import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors telescopeObjectTraversal.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-calibrationattachroutes-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { getArchiveDir } from '../../server/lib/library/archiveFolders';
import { stmts } from '../../server/lib/library/objects';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });

  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test-request';
    req.userId = 'test-user';
    req.userRole = 'admin';
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

function writeFrame(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), 'frame-bytes');
}

function makeObject(objectId: string, objectName: string) {
  stmts.upsertObject.run(
    objectId, objectId, 1, new Date().toISOString(), 0, null,
    null, objectName, null, null, null, null, null, null, null,
  );
}

describe('POST /calibrations/attach', () => {
  it('attaches a flat bundle to an object and echoes the resolved objectName back', async () => {
    writeFrame(path.join(getArchiveDir(null), 'Flats'), 'Flat_5.0s_Bin1_L_gain100_20260904-051928_2deg_-8.0C_0001.fit');
    makeObject('AttachRouteObj', 'Attach Route Object');

    const listRes = await fetch(`${baseUrl}/calibrations`);
    const listBody = await listRes.json();
    const group = listBody.data.groups.find((g: { folderName: string }) => g.folderName === 'Flats');
    const key = group.settingsGroups[0].key;

    const res = await fetch(`${baseUrl}/calibrations/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: null, folderName: 'Flats', key, objectId: 'AttachRouteObj', date: '2026-09-04' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.attachment).toMatchObject({
      objectId: 'AttachRouteObj', objectName: 'Attach Route Object', date: '2026-09-04', calibrationType: 'flat',
    });
  });

  it('rejects attaching a dark bundle with 400 NOT_ATTACHABLE — darks are shared across sessions', async () => {
    writeFrame(path.join(getArchiveDir(null), 'Darks'), 'Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-8.0C_0001.fit');
    makeObject('DarkAttachAttempt', 'Dark Attach Attempt');

    const listRes = await fetch(`${baseUrl}/calibrations`);
    const listBody = await listRes.json();
    const group = listBody.data.groups.find((g: { folderName: string }) => g.folderName === 'Darks');
    const key = group.settingsGroups[0].key;

    const res = await fetch(`${baseUrl}/calibrations/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: null, folderName: 'Darks', key, objectId: 'DarkAttachAttempt' }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('NOT_ATTACHABLE');
  });

  it('404s for a bundle that does not exist', async () => {
    makeObject('NoBundleObj', 'No Bundle Object');
    const res = await fetch(`${baseUrl}/calibrations/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: null, folderName: 'NoSuchFolder', key: 'no-such-key', objectId: 'NoBundleObj' }),
    });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe('BUNDLE_NOT_FOUND');
  });

  it('404s for an object that does not exist', async () => {
    writeFrame(path.join(getArchiveDir(null), 'Flats', 'other'), 'Flat_9.0s_Bin1_L_gain50_20260905-051928_2deg_-9.0C_0001.fit');
    const listRes = await fetch(`${baseUrl}/calibrations`);
    const listBody = await listRes.json();
    const group = listBody.data.groups.find((g: { folderName: string }) => g.folderName === 'Flats');
    const key = group.settingsGroups.find((s: { exposureSec: number }) => s.exposureSec === 9).key;

    const res = await fetch(`${baseUrl}/calibrations/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: null, folderName: 'Flats', key, objectId: 'DoesNotExist' }),
    });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe('OBJECT_NOT_FOUND');
  });

  it('400s on a malformed body', async () => {
    const res = await fetch(`${baseUrl}/calibrations/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderName: 'Flats' }), // missing scope/key/objectId
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /calibrations/attach/:id', () => {
  it('detaches an existing attachment', async () => {
    writeFrame(path.join(getArchiveDir(null), 'Flats', 'detach-me'), 'Flat_7.0s_Bin1_L_gain100_20260906-051928_2deg_-8.0C_0001.fit');
    makeObject('DetachRouteObj', 'Detach Route Object');
    const listRes = await fetch(`${baseUrl}/calibrations`);
    const listBody = await listRes.json();
    const group = listBody.data.groups.find((g: { folderName: string }) => g.folderName === 'Flats');
    const key = group.settingsGroups.find((s: { exposureSec: number }) => s.exposureSec === 7).key;

    const attachRes = await fetch(`${baseUrl}/calibrations/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: null, folderName: 'Flats', key, objectId: 'DetachRouteObj' }),
    });
    const { data } = await attachRes.json();

    const delRes = await fetch(`${baseUrl}/calibrations/attach/${data.attachment.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);

    const delAgain = await fetch(`${baseUrl}/calibrations/attach/${data.attachment.id}`, { method: 'DELETE' });
    const delAgainBody = await delAgain.json();
    expect(delAgain.status).toBe(404);
    expect(delAgainBody.error?.code).toBe('ATTACHMENT_NOT_FOUND');
  });
});

describe('DELETE /calibrations/bundle', () => {
  it('permanently deletes a dark bundle from the archive', async () => {
    writeFrame(path.join(getArchiveDir(null), 'Darks', 'delete-route'), 'Dark_13.0s_Bin1_Dark_gain100_20260908-051928_2deg_-8.0C_0001.fit');
    const before = await (await fetch(`${baseUrl}/calibrations`)).json();
    const group = before.data.groups.find((g: { folderName: string }) => g.folderName === 'Darks');
    const key = group.settingsGroups.find((s: { exposureSec: number }) => s.exposureSec === 13).key;

    const res = await fetch(`${baseUrl}/calibrations/bundle`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: null, folderName: 'Darks', key }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual({ deleted: 1, failed: 0 });

    const after = await (await fetch(`${baseUrl}/calibrations`)).json();
    const stillThere = after.data.groups.find((g: { folderName: string }) => g.folderName === 'Darks')
      ?.settingsGroups.some((s: { exposureSec: number }) => s.exposureSec === 13);
    expect(stillThere).toBeFalsy();
  });

  it('rejects deleting a flat bundle with 400 NOT_DELETABLE_HERE — flats are managed by attaching, not deleting', async () => {
    writeFrame(path.join(getArchiveDir(null), 'Flats', 'delete-route-reject'), 'Flat_14.0s_Bin1_L_gain100_20260908-051928_2deg_-8.0C_0001.fit');
    const before = await (await fetch(`${baseUrl}/calibrations`)).json();
    const group = before.data.groups.find((g: { folderName: string }) => g.folderName === 'Flats');
    const key = group.settingsGroups.find((s: { exposureSec: number }) => s.exposureSec === 14).key;

    const res = await fetch(`${baseUrl}/calibrations/bundle`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: null, folderName: 'Flats', key }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('NOT_DELETABLE_HERE');

    // Still there — rejected before anything touched the archive.
    const after = await (await fetch(`${baseUrl}/calibrations`)).json();
    const stillThere = after.data.groups.find((g: { folderName: string }) => g.folderName === 'Flats')
      ?.settingsGroups.some((s: { exposureSec: number }) => s.exposureSec === 14);
    expect(stillThere).toBe(true);
  });

  it('404s for a bundle that does not exist', async () => {
    const res = await fetch(`${baseUrl}/calibrations/bundle`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: null, folderName: 'NoSuchFolder', key: 'no-such-key' }),
    });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe('BUNDLE_NOT_FOUND');
  });

  it('400s on a malformed body', async () => {
    const res = await fetch(`${baseUrl}/calibrations/bundle`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderName: 'Darks' }), // missing scope/key
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /calibrations enrichment', () => {
  it('includes the attachment on the matching flats settings group, and omits it entirely for darks', async () => {
    writeFrame(path.join(getArchiveDir(null), 'Flats', 'enrich'), 'Flat_11.0s_Bin1_L_gain100_20260907-051928_2deg_-8.0C_0001.fit');
    writeFrame(path.join(getArchiveDir(null), 'Darks', 'enrich'), 'Dark_11.0s_Bin1_Dark_gain100_20260907-051928_2deg_-8.0C_0001.fit');
    makeObject('EnrichObj', 'Enrich Object');

    const before = await (await fetch(`${baseUrl}/calibrations`)).json();
    const flatsGroup = before.data.groups.find((g: { folderName: string }) => g.folderName === 'Flats');
    const flatKey = flatsGroup.settingsGroups.find((s: { exposureSec: number }) => s.exposureSec === 11).key;

    await fetch(`${baseUrl}/calibrations/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: null, folderName: 'Flats', key: flatKey, objectId: 'EnrichObj' }),
    });

    const after = await (await fetch(`${baseUrl}/calibrations`)).json();
    const flatsSet = after.data.groups
      .find((g: { folderName: string }) => g.folderName === 'Flats')
      .settingsGroups.find((s: { exposureSec: number }) => s.exposureSec === 11);
    expect(flatsSet.attachments).toEqual([
      expect.objectContaining({ objectId: 'EnrichObj', objectName: 'Enrich Object' }),
    ]);

    const darksSet = after.data.groups
      .find((g: { folderName: string }) => g.folderName === 'Darks')
      .settingsGroups.find((s: { exposureSec: number }) => s.exposureSec === 11);
    expect(darksSet.attachments).toBeUndefined();
  });
});
