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

  it('handles login, cookie issuance, dual-mode auth, validate, sessions lifecycle, and logout', async () => {
    // 1. Mock Jellyfin server
    let mockIsAdmin = true;
    const jfServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/Users/AuthenticateByName' && req.method === 'POST') {
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
        } else if (req.url === '/Users/Me' && req.method === 'GET') {
          const token = req.headers['x-emby-token'];
          if (token === 'valid-jf-token') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                Id: 'jf-token-user',
                Name: 'TokenUser',
                Policy: { IsAdministrator: true },
              })
            );
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Unauthorized' }));
          }
        } else {
          res.writeHead(404).end();
        }
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
        secureCookies: false,
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

      // Verify Set-Cookie header is issued
      const setCookie = resAdmin.headers.get('set-cookie');
      assert.ok(setCookie);
      assert.ok(setCookie.includes('hm_session='));
      assert.ok(setCookie.includes('HttpOnly'));
      assert.ok(setCookie.includes('SameSite=Lax'));
      assert.ok(setCookie.includes('Path=/'));

      // Extract cookie string for cookie-based requests
      const cookieValue = setCookie.split(';')[0]; // "hm_session=<token>"

      // B. GET /api/v1/auth/me via Cookie (Dual-mode verification)
      const resMeCookie = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Cookie: cookieValue },
      });
      assert.strictEqual(resMeCookie.status, 200);
      const dataMeCookie = (await resMeCookie.json()) as any;
      assert.strictEqual(dataMeCookie.user.username, 'AdminUser');

      // C. GET /api/v1/auth/validate
      const resValidate = await fetch(`${baseUrl}/api/v1/auth/validate`, {
        headers: { Cookie: cookieValue },
      });
      assert.strictEqual(resValidate.status, 200);
      const dataValidate = (await resValidate.json()) as any;
      assert.strictEqual(dataValidate.valid, true);
      assert.strictEqual(dataValidate.user.username, 'AdminUser');
      assert.ok(dataValidate.session.id);
      assert.ok(dataValidate.session.expiresAt);

      // D. GET /api/v1/auth/validate without token returns 401
      const resValidateUnauth = await fetch(`${baseUrl}/api/v1/auth/validate`);
      assert.strictEqual(resValidateUnauth.status, 401);
      const dataValidateUnauth = (await resValidateUnauth.json()) as any;
      assert.strictEqual(dataValidateUnauth.valid, false);

      // E. POST /api/v1/auth/validate-jellyfin
      const resJfValSuccess = await fetch(`${baseUrl}/api/v1/auth/validate-jellyfin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'valid-jf-token' }),
      });
      assert.strictEqual(resJfValSuccess.status, 200);
      const dataJfValSuccess = (await resJfValSuccess.json()) as any;
      assert.strictEqual(dataJfValSuccess.valid, true);
      assert.strictEqual(dataJfValSuccess.username, 'TokenUser');
      assert.strictEqual(dataJfValSuccess.isAdministrator, true);

      // Invalid token to validate-jellyfin
      const resJfValFail = await fetch(`${baseUrl}/api/v1/auth/validate-jellyfin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'invalid-jf-token' }),
      });
      assert.strictEqual(resJfValFail.status, 401);

      // Missing token to validate-jellyfin
      const resJfValMissing = await fetch(`${baseUrl}/api/v1/auth/validate-jellyfin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.strictEqual(resJfValMissing.status, 400);

      // F. Create a second session for AdminUser (e.g. login from second device)
      const resAdmin2 = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'AdminUser', password: 'pwd' }),
      });
      assert.strictEqual(resAdmin2.status, 200);
      const dataAdmin2 = (await resAdmin2.json()) as any;

      // G. GET /api/v1/auth/sessions lists active sessions
      const resSessions = await fetch(`${baseUrl}/api/v1/auth/sessions`, {
        headers: { Authorization: `Bearer ${dataAdmin.token}` },
      });
      assert.strictEqual(resSessions.status, 200);
      const dataSessions = (await resSessions.json()) as any;
      assert.strictEqual(dataSessions.sessions.length, 2);

      const currentSession = dataSessions.sessions.find((s: any) => s.isCurrent);
      assert.ok(currentSession);
      const otherSession = dataSessions.sessions.find((s: any) => !s.isCurrent);
      assert.ok(otherSession);

      // H. DELETE /api/v1/auth/sessions/:id revokes specific other session
      const resDelSession = await fetch(`${baseUrl}/api/v1/auth/sessions/${otherSession.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${dataAdmin.token}` },
      });
      assert.strictEqual(resDelSession.status, 200);
      const dataDelSession = (await resDelSession.json()) as any;
      assert.strictEqual(dataDelSession.status, 'ok');
      assert.strictEqual(dataDelSession.revokedSessionId, otherSession.id);

      // Check revoked session is gone
      const resCheckOther = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${dataAdmin2.token}` },
      });
      assert.strictEqual(resCheckOther.status, 401);

      // I. POST /api/v1/auth/sessions/revoke-all with keepCurrent: true
      // Create another session first
      await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'AdminUser', password: 'pwd' }),
      });

      const resRevokeAll = await fetch(`${baseUrl}/api/v1/auth/sessions/revoke-all`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dataAdmin.token}`,
        },
        body: JSON.stringify({ keepCurrent: true }),
      });
      assert.strictEqual(resRevokeAll.status, 200);
      const dataRevokeAll = (await resRevokeAll.json()) as any;
      assert.strictEqual(dataRevokeAll.revokedCount, 1);

      // Calling session is still active
      const resStillActive = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${dataAdmin.token}` },
      });
      assert.strictEqual(resStillActive.status, 200);

      // J. POST /api/v1/auth/logout clears cookie and revokes session
      const resLogout = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { Cookie: cookieValue },
      });
      assert.strictEqual(resLogout.status, 200);
      const logoutCookie = resLogout.headers.get('set-cookie');
      assert.ok(logoutCookie);
      assert.ok(logoutCookie.includes('Max-Age=0'));

      // Subsequent call fails
      const resAfterLogout = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Cookie: cookieValue },
      });
      assert.strictEqual(resAfterLogout.status, 401);
    } finally {
      db.close();
    }
  });
});
