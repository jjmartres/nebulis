import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

import db from '../../server/lib/db';
import { registerUser, loginUser, updateUserRole, getUserById } from '../../server/lib/auth';
import { apiAuth, requireAdmin } from '../../server/middleware/auth';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';

/**
 * HIGH 3, from auditreport.md: `updateUserRole` changed the `users.role` column
 * only, and the auth middleware took the role from the signed JWT claim for
 * login tokens (the device-token branch already re-read it). A demoted admin
 * therefore kept admin rights until the 30-day token expiry or a password
 * change, while `/auth/me` reported the live role — the UI showed "viewer" and
 * the server still authorized admin.
 *
 * These tests mint a real token, change the role, and then make a real request
 * through the real middleware, so they cover the claim-vs-DB gap end to end.
 */
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use(apiAuth);
  // Mirror of a real admin-only surface (user management, library deletes).
  app.get('/api/admin-only', requireAdmin, (_req, res) => { res.json({ ok: true }); });
  app.get('/api/whoami', (req, res) => { res.json({ role: req.userRole }); });

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  db.prepare('DELETE FROM users').run();
});

const get = (path: string, token: string) =>
  fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });

describe('role changes reach already-issued login tokens', () => {
  it('a demoted admin token stops passing requireAdmin immediately', async () => {
    const { user } = await registerUser('admin1', 'password123'); // first user is admin
    expect(user.role).toBe('admin');
    const { token } = await loginUser('admin1', 'password123');

    // Sanity: the token works while they are an admin.
    expect((await get('/api/admin-only', token)).status).toBe(200);

    expect(updateUserRole(user.id, 'viewer')).toBe(true);

    // The token is still a VALID session (no forced logout) ...
    expect((await get('/api/whoami', token)).status).toBe(200);
    // ... but it no longer carries admin rights.
    const after = await get('/api/admin-only', token);
    expect(after.status).toBe(403);
    expect((await after.json()).error?.code).toBe('FORBIDDEN');
  });

  it('reports the live role, never the stale claim', async () => {
    const { user } = await registerUser('admin2', 'password123');
    const { token } = await loginUser('admin2', 'password123');
    expect((await (await get('/api/whoami', token)).json()).data.role).toBe('admin');

    updateUserRole(user.id, 'viewer');
    expect((await (await get('/api/whoami', token)).json()).data.role).toBe('viewer');

    // And back up again: a promotion is live too, with no re-login.
    updateUserRole(user.id, 'admin');
    expect((await (await get('/api/whoami', token)).json()).data.role).toBe('admin');
  });

  it('still invalidates the token when the password changes', async () => {
    const { user } = await registerUser('admin3', 'password123');
    const { token } = await loginUser('admin3', 'password123');

    // updateUserPassword bumps tokenVersion; that path must keep working.
    const { updateUserPassword } = await import('../../server/lib/auth');
    await updateUserPassword(user.id, 'newpassword123');

    const res = await get('/api/whoami', token);
    expect(res.status).toBe(401);
    expect((await res.json()).error?.code).toBe('SESSION_INVALIDATED');
  });

  it('still rejects a token whose user has been deleted', async () => {
    const { user } = await registerUser('admin4', 'password123');
    const { token } = await loginUser('admin4', 'password123');
    expect(getUserById(user.id)).toBeDefined();

    const { deleteUser } = await import('../../server/lib/auth');
    deleteUser(user.id);

    const res = await get('/api/whoami', token);
    expect(res.status).toBe(401);
    expect((await res.json()).error?.code).toBe('USER_NOT_FOUND');
  });
});
