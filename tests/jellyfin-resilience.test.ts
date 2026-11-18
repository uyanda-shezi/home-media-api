import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { signToken } from '../src/auth/crypto.js';
import { upsertUserAndCreateSession, updateUserRole } from '../src/users/service.js';
import { handleJellyfinRequest } from '../src/jellyfin/router.js';
import type { AppConfig } from '../src/config.js';

describe('Jellyfin Integration Resilience & Authority Boundaries', () => {
  const activeServers: http.Server[] = [];
  const testDir = join(process.cwd(), 'tmp-test-jf-resilience');
  const dbPath = join(testDir, 'jf-resilience.db');
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

  it('enforces authority boundaries: request_only users are restricted strictly to search and availability', async () => {
    // Mock upstream server responding to search and availability
    const mockJellyfin = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
    });
    await new Promise<void>((r) => mockJellyfin.listen(0, '127.0.0.1', () => r()));
    activeServers.push(mockJellyfin);
    const jfPort = (mockJellyfin.address() as { port: number }).port;

    const db = createDb(dbPath);
    try {
      runMigrations(db, './migrations');

      // Admin user first
      upsertUserAndCreateSession(db, {
        userId: 'admin-1',
        username: 'Admin',
        isAdministrator: true,
        accessToken: 'token-admin',
      });

      // Standard user demoted to request_only
      const reqOnlyCtx = upsertUserAndCreateSession(db, {
        userId: 'req-only-1',
        username: 'RequestOnlyUser',
        isAdministrator: false,
        accessToken: 'token-req-only',
      });
      updateUserRole(db, reqOnlyCtx.user.id, 'request_only');

      const reqOnlyToken = signToken(
        { sid: reqOnlyCtx.session.id, uid: reqOnlyCtx.user.id, exp: Date.now() + 3600_000 },
        secret
      );

      const config: AppConfig = {
        port: 3000,
        databasePath: dbPath,
        jellyfinUrl: `http://127.0.0.1:${jfPort}`,
        sessionSecret: secret,
        sessionTtlDays: 7,
      };

      const server = http.createServer(async (req, res) => {
        const handled = await handleJellyfinRequest(req, res, db, config);
        if (!handled) res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      activeServers.push(server);
      const apiPort = (server.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${apiPort}`;

      // 1. request_only CAN access search
      const resSearch = await fetch(`${baseUrl}/api/v1/jellyfin/search?q=test`, {
        headers: { Authorization: `Bearer ${reqOnlyToken}` },
      });
      assert.strictEqual(resSearch.status, 200);

      // 2. request_only CAN access availability
      const resAvail = await fetch(`${baseUrl}/api/v1/jellyfin/availability?tmdbId=123`, {
        headers: { Authorization: `Bearer ${reqOnlyToken}` },
      });
      assert.strictEqual(resAvail.status, 200);

      // 3. request_only CANNOT access libraries -> 403 Forbidden
      const resLibs = await fetch(`${baseUrl}/api/v1/jellyfin/libraries`, {
        headers: { Authorization: `Bearer ${reqOnlyToken}` },
      });
      assert.strictEqual(resLibs.status, 403);

      // 4. request_only CANNOT access library items -> 403 Forbidden
      const resLibItems = await fetch(`${baseUrl}/api/v1/jellyfin/libraries/any-id/items`, {
        headers: { Authorization: `Bearer ${reqOnlyToken}` },
      });
      assert.strictEqual(resLibItems.status, 403);

      // 5. request_only CANNOT access item details -> 403 Forbidden
      const resDetails = await fetch(`${baseUrl}/api/v1/jellyfin/items/any-id`, {
        headers: { Authorization: `Bearer ${reqOnlyToken}` },
      });
      assert.strictEqual(resDetails.status, 403);

      // 6. request_only CANNOT access playback metadata -> 403 Forbidden
      const resPlayback = await fetch(`${baseUrl}/api/v1/jellyfin/items/any-id/playback`, {
        headers: { Authorization: `Bearer ${reqOnlyToken}` },
      });
      assert.strictEqual(resPlayback.status, 403);

      // 7. request_only CANNOT report progress -> 403 Forbidden
      const resProgress = await fetch(`${baseUrl}/api/v1/jellyfin/items/any-id/progress`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${reqOnlyToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ positionTicks: 100 }),
      });
      assert.strictEqual(resProgress.status, 403);

      // 8. request_only CANNOT toggle played status -> 403 Forbidden
      const resPlayed = await fetch(`${baseUrl}/api/v1/jellyfin/items/any-id/played`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${reqOnlyToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ played: true }),
      });
      assert.strictEqual(resPlayed.status, 403);

      // 9. Unauthenticated requests receive 401 Unauthorized
      const resUnauth = await fetch(`${baseUrl}/api/v1/jellyfin/libraries`);
      assert.strictEqual(resUnauth.status, 401);

      const resSearchUnauth = await fetch(`${baseUrl}/api/v1/jellyfin/search?q=test`);
      assert.strictEqual(resSearchUnauth.status, 401);
    } finally {
      db.close();
    }
  });

  it('validates query inputs and returns 400 Bad Request on malformed requests', async () => {
    const db = createDb(dbPath);
    try {
      runMigrations(db, './migrations');

      const userCtx = upsertUserAndCreateSession(db, {
        userId: 'admin-1',
        username: 'Admin',
        isAdministrator: true,
        accessToken: 'token-admin',
      });
      const token = signToken(
        { sid: userCtx.session.id, uid: userCtx.user.id, exp: Date.now() + 3600_000 },
        secret
      );

      const config: AppConfig = {
        port: 3000,
        databasePath: dbPath,
        jellyfinUrl: 'http://127.0.0.1:8096',
        sessionSecret: secret,
        sessionTtlDays: 7,
      };

      const server = http.createServer(async (req, res) => {
        const handled = await handleJellyfinRequest(req, res, db, config);
        if (!handled) res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      activeServers.push(server);
      const apiPort = (server.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${apiPort}`;

      // A. Empty search query
      const resEmptySearch = await fetch(`${baseUrl}/api/v1/jellyfin/search?q=   `, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(resEmptySearch.status, 400);

      // B. Invalid type in search
      const resBadType = await fetch(`${baseUrl}/api/v1/jellyfin/search?q=movie&type=invalid_type`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(resBadType.status, 400);

      // C. Availability without any provider ID
      const resNoProvider = await fetch(`${baseUrl}/api/v1/jellyfin/availability`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(resNoProvider.status, 400);

      // D. Progress without valid positionTicks
      const resBadProgress = await fetch(`${baseUrl}/api/v1/jellyfin/items/item-1/progress`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ positionTicks: -50 }),
      });
      assert.strictEqual(resBadProgress.status, 400);
    } finally {
      db.close();
    }
  });

  it('handles upstream failures and offline servers gracefully with HTTP 502', async () => {
    const db = createDb(dbPath);
    try {
      runMigrations(db, './migrations');

      const userCtx = upsertUserAndCreateSession(db, {
        userId: 'admin-1',
        username: 'Admin',
        isAdministrator: true,
        accessToken: 'token-admin',
      });
      const token = signToken(
        { sid: userCtx.session.id, uid: userCtx.user.id, exp: Date.now() + 3600_000 },
        secret
      );

      // Pointing to dead port (connection refused)
      const config: AppConfig = {
        port: 3000,
        databasePath: dbPath,
        jellyfinUrl: 'http://127.0.0.1:1',
        sessionSecret: secret,
        sessionTtlDays: 7,
      };

      const server = http.createServer(async (req, res) => {
        const handled = await handleJellyfinRequest(req, res, db, config);
        if (!handled) res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      activeServers.push(server);
      const apiPort = (server.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${apiPort}`;

      // Search to offline Jellyfin returns 502
      const resOffline = await fetch(`${baseUrl}/api/v1/jellyfin/search?q=test`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(resOffline.status, 502);
      const dataOffline = (await resOffline.json()) as any;
      assert.ok(dataOffline.error);
    } finally {
      db.close();
    }
  });
});
