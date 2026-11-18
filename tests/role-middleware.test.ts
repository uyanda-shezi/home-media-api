import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { signToken } from '../src/auth/crypto.js';
import { handleUsersRequest } from '../src/users/router.js';
import { upsertUserAndCreateSession } from '../src/users/service.js';
import type { AppConfig } from '../src/config.js';

describe('Household Role Middleware & Management', () => {
  const activeServers: http.Server[] = [];
  const testDir = join(process.cwd(), 'tmp-test-roles');
  const dbPath = join(testDir, 'roles.db');
  const secret = 'test_secret_key_at_least_32_chars_long_12345';

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    while (activeServers.length > 0) {
      const s = activeServers.pop();
      if (s) {
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('enforces admin role on GET /api/v1/users, blocking standard/request_only users', async () => {
    const db = createDb(dbPath);
    try {
      runMigrations(db, './migrations');

      const config: AppConfig = {
        port: 3000,
        databasePath: dbPath,
        sessionSecret: secret,
        sessionTtlDays: 7,
      };

      const server = http.createServer(async (req, res) => {
        const handled = await handleUsersRequest(req, res, db, config);
        if (!handled) res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      activeServers.push(server);

      const port = (server.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      // Create Admin User
      const adminCtx = upsertUserAndCreateSession(db, {
        userId: 'jf-admin-1',
        username: 'AdminOne',
        isAdministrator: true,
        accessToken: 'jf-token-1',
      });
      const adminToken = signToken(
        {
          sid: adminCtx.session.id,
          uid: adminCtx.user.id,
          exp: Date.now() + 3600_000,
        },
        secret
      );

      // Create Standard User
      const standardCtx = upsertUserAndCreateSession(db, {
        userId: 'jf-std-1',
        username: 'StandardOne',
        isAdministrator: false,
        accessToken: 'jf-token-2',
      });
      const standardToken = signToken(
        {
          sid: standardCtx.session.id,
          uid: standardCtx.user.id,
          exp: Date.now() + 3600_000,
        },
        secret
      );

      // 1. Admin accesses GET /api/v1/users -> 200 OK
      const resAdmin = await fetch(`${baseUrl}/api/v1/users`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(resAdmin.status, 200);
      const dataAdmin = (await resAdmin.json()) as any;
      assert.strictEqual(Array.isArray(dataAdmin.users), true);
      assert.strictEqual(dataAdmin.users.length, 2);

      // 2. Standard user accesses GET /api/v1/users -> 403 Forbidden
      const resStd = await fetch(`${baseUrl}/api/v1/users`, {
        headers: { Authorization: `Bearer ${standardToken}` },
      });
      assert.strictEqual(resStd.status, 403);
      const dataStd = (await resStd.json()) as any;
      assert.strictEqual(dataStd.error, 'Forbidden: Insufficient household role');

      // 3. Unauthenticated access -> 401 Unauthorized
      const resUnauth = await fetch(`${baseUrl}/api/v1/users`);
      assert.strictEqual(resUnauth.status, 401);
    } finally {
      db.close();
    }
  });

  it('manages role updates and strictly enforces the last-admin guard', async () => {
    const db = createDb(dbPath);
    try {
      runMigrations(db, './migrations');

      const config: AppConfig = {
        port: 3000,
        databasePath: dbPath,
        sessionSecret: secret,
        sessionTtlDays: 7,
      };

      const server = http.createServer(async (req, res) => {
        const handled = await handleUsersRequest(req, res, db, config);
        if (!handled) res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      activeServers.push(server);

      const port = (server.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      // Seed Sole Admin User
      const adminCtx = upsertUserAndCreateSession(db, {
        userId: 'jf-sole-admin',
        username: 'SoleAdmin',
        isAdministrator: true,
        accessToken: 'jf-token-1',
      });
      const adminToken = signToken(
        {
          sid: adminCtx.session.id,
          uid: adminCtx.user.id,
          exp: Date.now() + 3600_000,
        },
        secret
      );

      // Seed Standard User
      const memberCtx = upsertUserAndCreateSession(db, {
        userId: 'jf-member-1',
        username: 'FamilyMember',
        isAdministrator: false,
        accessToken: 'jf-token-2',
      });

      // A. Admin updates standard user to 'request_only' -> 200 OK
      const resRoleUpdate = await fetch(`${baseUrl}/api/v1/users/${memberCtx.user.id}/role`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'request_only' }),
      });
      assert.strictEqual(resRoleUpdate.status, 200);
      const dataRoleUpdate = (await resRoleUpdate.json()) as any;
      assert.strictEqual(dataRoleUpdate.user.role, 'request_only');

      // B. Reject invalid role string with 400 Bad Request
      const resInvalidRole = await fetch(`${baseUrl}/api/v1/users/${memberCtx.user.id}/role`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'superadmin_invalid' }),
      });
      assert.strictEqual(resInvalidRole.status, 400);

      // C. Reject non-existent user with 404 Not Found
      const resNotFound = await fetch(`${baseUrl}/api/v1/users/non-existent-uuid/role`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'admin' }),
      });
      assert.strictEqual(resNotFound.status, 404);

      // D. LAST-ADMIN GUARD: Attempt to demote sole admin to 'standard' -> 400 Bad Request
      const resDemoteSole = await fetch(`${baseUrl}/api/v1/users/${adminCtx.user.id}/role`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'standard' }),
      });
      assert.strictEqual(resDemoteSole.status, 400);
      const dataDemoteSole = (await resDemoteSole.json()) as any;
      assert.strictEqual(dataDemoteSole.error, 'Cannot demote the last remaining household admin');

      // E. Promote second user to admin
      const resPromote = await fetch(`${baseUrl}/api/v1/users/${memberCtx.user.id}/role`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'admin' }),
      });
      assert.strictEqual(resPromote.status, 200);

      // F. Now demoting original admin succeeds because second admin exists!
      const resDemoteAllowed = await fetch(`${baseUrl}/api/v1/users/${adminCtx.user.id}/role`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'standard' }),
      });
      assert.strictEqual(resDemoteAllowed.status, 200);
      const dataDemoteAllowed = (await resDemoteAllowed.json()) as any;
      assert.strictEqual(dataDemoteAllowed.user.role, 'standard');
    } finally {
      db.close();
    }
  });
});
