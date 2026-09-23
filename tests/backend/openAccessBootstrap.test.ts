import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

import db from '../../server/lib/db';
import { apiAuth, requireAdmin } from '../../server/middleware/auth';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';

/**
 * MEDIUM 1, from auditreport.md: with no API key and no users, the open-access
 * bootstrap granted `req.userRole = 'admin'` to every unauthenticated
 * GET/HEAD/OPTIONS. That satisfied `requireAdmin` on the admin-gated reads, so
 * a LAN neighbour could browse the host filesystem via `GET /storage/browse`
 * (and read /storage/volumes, /storage/db-backups, /devices/admin/all,
 * /auth/users) on a fresh or Docker install before the owner had registered.
 *
 * The bootstrap still has to let the first-run client read the non-admin
 * surface and register, so this pins both halves: admin reads are refused while
 * the users table is empty, ordinary authenticated reads still work, and
 * registering (which the PUBLIC_AUTH list handles) restores full admin access.
 */
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use(apiAuth);
  app.get('/api/admin-only', requireAdmin, (_req, res) => { res.json({ ok: 'admin' }); });
  app.get('/api/any-auth', (req, res) => { res.json({ role: req.userRole }); });

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  // A genuinely fresh install: no users, and no configured API key (which would
  // otherwise take the AUTH_REQUIRED branch instead of the bootstrap).
  db.prepare('DELETE FROM users').run();
  db.prepare("UPDATE appSettings SET apiKey = '' WHERE id = 1").run();
});

describe('open-access bootstrap grants viewer, not admin', () => {
  it('refuses an admin-gated GET while no user exists', async () => {
    const res = await fetch(`${baseUrl}/api/admin-only`);
    expect(res.status).toBe(403);
    expect((await res.json()).error?.code).toBe('FORBIDDEN');
  });

  it('still allows an ordinary GET, as a viewer', async () => {
    const res = await fetch(`${baseUrl}/api/any-auth`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.role).toBe('viewer');
  });

  it('still denies state-changing requests until the first user exists', async () => {
    const res = await fetch(`${baseUrl}/api/any-auth`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect((await res.json()).error?.code).toBe('SETUP_REQUIRED');
  });

  it('an admin token from registration restores admin access', async () => {
    const { registerUser, loginUser } = await import('../../server/lib/auth');
    await registerUser('firstadmin', 'password123');
    const { token } = await loginUser('firstadmin', 'password123');

    const res = await fetch(`${baseUrl}/api/admin-only`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });
});
