import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { handleAuthRequest } from '../src/auth/router.js';
import type { AppConfig } from '../src/config.js';

describe('Auth Flow & Session Management', () => {
  const activeServers: http.Server[] = [];
  const testDir = join(process.cwd(), 'tmp-test-auth-flow');
  const dbPath = join(testDir, 'auth.db');

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

  it('POST /api/v1/auth/login rejects empty or missing credentials with HTTP 400', async () => {
    const db = createDb(dbPath);
    try {
      runMigrations(db, './migrations');

      const config: AppConfig = {
        port: 3000,
        databasePath: dbPath,
        sessionSecret: 'test_secret_key_at_least_32_chars_long_12345',
        sessionTtlDays: 7,
      };

      const server = http.createServer(async (req, res) => {
        const handled = await handleAuthRequest(req, res, db, config);
        if (!handled) res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      activeServers.push(server);

      const port = (server.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      // Missing body
      const resEmpty = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.strictEqual(resEmpty.status, 400);

      // Empty string
      const resBlank = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '   ', password: '' }),
      });
      assert.strictEqual(resBlank.status, 400);
    } finally {
      db.close();
    }
  });

  it('handles login, role default assignment, session issuance, and excludes secret tokens', async () => {
    // 1. Mock Jellyfin server
    let mockIsAdmin = true;
    const jfServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { Username } = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            User: {
              Id: `jf-${Username}`,
              Name: Username,
              Policy: { IsAdministrator: mockIsAdmin },
            },
            AccessToken: `secret-jf-access-token-for-${Username}`,
          })
        );
      });
    });
    await new Promise<void>((r) => jfServer.listen(0, '127.0.0.1', () => r()));
    activeServers.push(jfServer);
    const jfPort = (jfServer.address() as { port: number }).port;

    const db = createDb(dbPath);
    try {
      runMigrations(db, './migrations');

      const config: AppConfig = {
        port: 3000,
        databasePath: dbPath,
        jellyfinUrl: `http://127.0.0.1:${jfPort}`,
        sessionSecret: 'test_secret_key_at_least_32_chars_long_12345',
        sessionTtlDays: 7,
      };

      const server = http.createServer(async (req, res) => {
        const handled = await handleAuthRequest(req, res, db, config);
        if (!handled) res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      activeServers.push(server);

      const port = (server.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      // A. Login Admin User
      mockIsAdmin = true;
      const resAdmin = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'AdminUser', password: 'pwd' }),
      });
      assert.strictEqual(resAdmin.status, 200);
      const dataAdmin = (await resAdmin.json()) as any;

      assert.ok(dataAdmin.token);
      assert.strictEqual(dataAdmin.user.username, 'AdminUser');
      assert.strictEqual(dataAdmin.user.role, 'admin');
      // Crucial: check that jellyfin_access_token and password are never in the response
      assert.strictEqual(dataAdmin.jellyfin_access_token, undefined);
      assert.strictEqual(dataAdmin.AccessToken, undefined);
      assert.strictEqual(dataAdmin.password, undefined);

      // B. Login Non-Admin User (standard role)
      mockIsAdmin = false;
      const resStandard = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'RegularUser', password: 'pwd' }),
      });
      assert.strictEqual(resStandard.status, 200);
      const dataStandard = (await resStandard.json()) as any;
      assert.strictEqual(dataStandard.user.role, 'standard');

      // C. Subsequent login preserves assigned role even if Jellyfin isAdministrator changes
      // Suppose RegularUser is granted Jellyfin admin externally, but household role is 'standard'
      mockIsAdmin = true;
      const resSubsequent = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'RegularUser', password: 'pwd' }),
      });
      const dataSubsequent = (await resSubsequent.json()) as any;
      assert.strictEqual(dataSubsequent.user.role, 'standard'); // preserved!

      // D. GET /api/v1/auth/me with valid token
      const resMe = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${dataAdmin.token}` },
      });
      assert.strictEqual(resMe.status, 200);
      const dataMe = (await resMe.json()) as any;
      assert.strictEqual(dataMe.user.username, 'AdminUser');
      assert.strictEqual(dataMe.user.role, 'admin');

      // E. GET /api/v1/auth/me without token or invalid token returns 401
      const resNoToken = await fetch(`${baseUrl}/api/v1/auth/me`);
      assert.strictEqual(resNoToken.status, 401);

      const resBadToken = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer bad.token` },
      });
      assert.strictEqual(resBadToken.status, 401);

      // F. POST /api/v1/auth/logout revokes session
      const resLogout = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${dataAdmin.token}` },
      });
      assert.strictEqual(resLogout.status, 200);
      const dataLogout = (await resLogout.json()) as any;
      assert.strictEqual(dataLogout.status, 'ok');

      // G. Request with revoked token now returns 401
      const resAfterLogout = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${dataAdmin.token}` },
      });
      assert.strictEqual(resAfterLogout.status, 401);
    } finally {
      db.close();
    }
  });
});
