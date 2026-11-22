import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { signToken } from '../src/auth/crypto.js';
import { upsertUserAndCreateSession, updateUserRole } from '../src/users/service.js';
import { handleSeerrRequest } from '../src/seerr/router.js';
import type { AppConfig } from '../src/config.js';

describe('Seerr Integration Resilience & Authority Boundaries', () => {
  const activeServers: http.Server[] = [];
  const testDir = join(process.cwd(), 'tmp-test-seerr-resilience');
  const dbPath = join(testDir, 'seerr-resilience.db');
  const secret = 'test_secret_key_at_least_32_chars_long_12345';
  const superSecretApiKey = 'SUPER_SECRET_SEERR_KEY_12345';

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

  it('enforces authority boundaries: role guards for approval, decline, and cross-user cancellation', async () => {
    // Upstream Seerr mock
    const mockSeerr = http.createServer((req, res) => {
      const url = req.url || '';
      const method = req.method || 'GET';

      // User directory
      if (url.startsWith('/api/v1/user')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            results: [
              { id: 1, username: 'admin', jellyfinUserId: 'jf-admin-1' },
              { id: 2, username: 'bob', jellyfinUserId: 'jf-standard-2' },
              { id: 3, username: 'charlie', jellyfinUserId: 'jf-req-only-3' },
            ],
          })
        );
        return;
      }

      // Request 100: Owned by Bob (status: pending)
      if (url === '/api/v1/request/100' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 100,
            status: 1, // Pending
            requestedBy: { id: 2, username: 'bob', jellyfinUserId: 'jf-standard-2' },
          })
        );
        return;
      }

      // Request 200: Owned by Charlie (status: approved)
      if (url === '/api/v1/request/200' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 200,
            status: 2, // Approved
            requestedBy: { id: 3, username: 'charlie', jellyfinUserId: 'jf-req-only-3' },
          })
        );
        return;
      }

      // Delete endpoint
      if (url.startsWith('/api/v1/request/') && method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    await new Promise<void>((r) => mockSeerr.listen(0, '127.0.0.1', () => r()));
    activeServers.push(mockSeerr);
    const seerrPort = (mockSeerr.address() as { port: number }).port;

    const db = createDb(dbPath);
    runMigrations(db, './migrations');

    // Admin
    const adminCtx = upsertUserAndCreateSession(db, {
      userId: 'jf-admin-1',
      username: 'Admin',
      isAdministrator: true,
      accessToken: 'token-admin',
    });
    const adminToken = signToken(
      { sid: adminCtx.session.id, uid: adminCtx.user.id, exp: Date.now() + 3600_000 },
      secret
    );

    // Standard User (Bob)
    const bobCtx = upsertUserAndCreateSession(db, {
      userId: 'jf-standard-2',
      username: 'Bob',
      isAdministrator: false,
      accessToken: 'token-bob',
    });
    const bobToken = signToken(
      { sid: bobCtx.session.id, uid: bobCtx.user.id, exp: Date.now() + 3600_000 },
      secret
    );

    // Request-Only User (Charlie)
    const charlieCtx = upsertUserAndCreateSession(db, {
      userId: 'jf-req-only-3',
      username: 'Charlie',
      isAdministrator: false,
      accessToken: 'token-charlie',
    });
    updateUserRole(db, charlieCtx.user.id, 'request_only');
    const charlieToken = signToken(
      { sid: charlieCtx.session.id, uid: charlieCtx.user.id, exp: Date.now() + 3600_000 },
      secret
    );

    const config: AppConfig = {
      port: 0,
      databasePath: dbPath,
      seerrUrl: `http://127.0.0.1:${seerrPort}`,
      seerrApiKey: superSecretApiKey,
      sessionSecret: secret,
      sessionTtlDays: 7,
    };

    const appServer = http.createServer(async (req, res) => {
      if (await handleSeerrRequest(req, res, db, config)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    activeServers.push(appServer);
    const appPort = (appServer.address() as { port: number }).port;

    // 1. Unauthenticated requests receive 401 across endpoints
    const unauthSearch = await fetch(`http://127.0.0.1:${appPort}/api/v1/seerr/search?q=test`);
    assert.strictEqual(unauthSearch.status, 401);

    const unauthReqs = await fetch(`http://127.0.0.1:${appPort}/api/v1/seerr/requests`);
    assert.strictEqual(unauthReqs.status, 401);

    // 2. Standard user cannot approve or decline requests (403 Forbidden)
    const bobApprove = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/requests/100/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bobToken}` },
      }
    );
    assert.strictEqual(bobApprove.status, 403);

    const bobDecline = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/requests/100/decline`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bobToken}` },
      }
    );
    assert.strictEqual(bobDecline.status, 403);

    // 3. Request-Only user cannot approve or decline requests (403 Forbidden)
    const charlieApprove = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/requests/100/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${charlieToken}` },
      }
    );
    assert.strictEqual(charlieApprove.status, 403);

    // 4. Cross-user cancellation: Charlie attempts to cancel Bob's request (403 Forbidden)
    const crossCancel = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/requests/100`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${charlieToken}` },
      }
    );
    assert.strictEqual(crossCancel.status, 403);
    const crossCancelData = (await crossCancel.json()) as any;
    assert.strictEqual(crossCancelData.error, 'You can only cancel your own requests');

    // 5. Already approved cancellation: Charlie attempts to cancel their own approved request (403 Forbidden)
    const approvedCancel = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/requests/200`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${charlieToken}` },
      }
    );
    assert.strictEqual(approvedCancel.status, 403);
    const approvedCancelData = (await approvedCancel.json()) as any;
    assert.strictEqual(
      approvedCancelData.error,
      'Cannot cancel a request that has already been approved or processed'
    );

    // 6. Admin CAN delete/cancel another user's request
    const adminCancel = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/requests/100`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    assert.strictEqual(adminCancel.status, 200);

    db.close();
  });

  it('validates request and search inputs with HTTP 400', async () => {
    const db = createDb(dbPath);
    runMigrations(db, './migrations');

    const adminCtx = upsertUserAndCreateSession(db, {
      userId: 'jf-admin-1',
      username: 'Admin',
      isAdministrator: true,
      accessToken: 'token-admin',
    });
    const token = signToken(
      { sid: adminCtx.session.id, uid: adminCtx.user.id, exp: Date.now() + 3600_000 },
      secret
    );

    const config: AppConfig = {
      port: 0,
      databasePath: dbPath,
      seerrUrl: 'http://127.0.0.1:9999',
      seerrApiKey: superSecretApiKey,
      sessionSecret: secret,
      sessionTtlDays: 7,
    };

    const appServer = http.createServer(async (req, res) => {
      if (await handleSeerrRequest(req, res, db, config)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    activeServers.push(appServer);
    const appPort = (appServer.address() as { port: number }).port;

    // 1. Empty or missing search query
    const emptySearch = await fetch(`http://127.0.0.1:${appPort}/api/v1/seerr/search`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(emptySearch.status, 400);

    const whitespaceSearch = await fetch(`http://127.0.0.1:${appPort}/api/v1/seerr/search?q=%20%20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(whitespaceSearch.status, 400);

    // 2. Invalid search type
    const invalidType = await fetch(`http://127.0.0.1:${appPort}/api/v1/seerr/search?q=test&type=invalid`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(invalidType.status, 400);

    // 3. Invalid mediaType in request
    const invalidMediaType = await fetch(`http://127.0.0.1:${appPort}/api/v1/seerr/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mediaType: 'podcast', mediaId: 10 }),
    });
    assert.strictEqual(invalidMediaType.status, 400);

    // 4. Invalid mediaId
    const invalidMediaId = await fetch(`http://127.0.0.1:${appPort}/api/v1/seerr/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mediaType: 'movie', mediaId: -5 }),
    });
    assert.strictEqual(invalidMediaId.status, 400);

    // 5. TV request with missing/invalid seasons
    const missingSeasons = await fetch(`http://127.0.0.1:${appPort}/api/v1/seerr/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mediaType: 'tv', mediaId: 100 }),
    });
    assert.strictEqual(missingSeasons.status, 400);

    const emptySeasons = await fetch(`http://127.0.0.1:${appPort}/api/v1/seerr/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mediaType: 'tv', mediaId: 100, seasons: [] }),
    });
    assert.strictEqual(emptySeasons.status, 400);

    db.close();
  });

  it('handles unconfigured state, offline servers, duplicate 409, and sanitizes secrets', async () => {
    const db = createDb(dbPath);
    runMigrations(db, './migrations');

    const adminCtx = upsertUserAndCreateSession(db, {
      userId: 'jf-admin-1',
      username: 'Admin',
      isAdministrator: true,
      accessToken: 'token-admin',
    });
    const token = signToken(
      { sid: adminCtx.session.id, uid: adminCtx.user.id, exp: Date.now() + 3600_000 },
      secret
    );

    // 1. Test Unconfigured Seerr (503 Service Unavailable)
    const unconfiguredConfig: AppConfig = {
      port: 0,
      databasePath: dbPath,
      seerrUrl: undefined,
      seerrApiKey: undefined,
      sessionSecret: secret,
      sessionTtlDays: 7,
    };

    const unconfServer = http.createServer(async (req, res) => {
      if (await handleSeerrRequest(req, res, db, unconfiguredConfig)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => unconfServer.listen(0, '127.0.0.1', () => r()));
    activeServers.push(unconfServer);
    const unconfPort = (unconfServer.address() as { port: number }).port;

    const unconfRes = await fetch(`http://127.0.0.1:${unconfPort}/api/v1/seerr/requests`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(unconfRes.status, 503);
    const unconfData = (await unconfRes.json()) as any;
    assert.strictEqual(unconfData.error, 'Media requester (Seerr) unconfigured');

    // 2. Test Offline Server (502 Bad Gateway)
    const offlineConfig: AppConfig = {
      port: 0,
      databasePath: dbPath,
      seerrUrl: 'http://127.0.0.1:54321', // Non-existent port
      seerrApiKey: superSecretApiKey,
      sessionSecret: secret,
      sessionTtlDays: 7,
    };

    const offlineServer = http.createServer(async (req, res) => {
      if (await handleSeerrRequest(req, res, db, offlineConfig)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => offlineServer.listen(0, '127.0.0.1', () => r()));
    activeServers.push(offlineServer);
    const offlinePort = (offlineServer.address() as { port: number }).port;

    const offlineRes = await fetch(`http://127.0.0.1:${offlinePort}/api/v1/seerr/search?q=test`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(offlineRes.status, 502);
    const offlineData = (await offlineRes.json()) as any;
    assert.ok(offlineData.error.includes('unreachable') || offlineData.error.includes('timed out'));

    // 3. Test Upstream Duplicate Request Handling (409 Conflict) and Secret Sanitization
    const mockSeerrWithLeak = http.createServer((req, res) => {
      const url = req.url || '';
      if (url.startsWith('/api/v1/user')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [] }));
        return;
      }
      if (url === '/api/v1/request') {
        // Return 409 Conflict with message that tries to leak key
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: `Request for media 550 already exists! Secret: ${superSecretApiKey}`,
            mediaId: 550,
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((r) => mockSeerrWithLeak.listen(0, '127.0.0.1', () => r()));
    activeServers.push(mockSeerrWithLeak);
    const leakPort = (mockSeerrWithLeak.address() as { port: number }).port;

    const leakConfig: AppConfig = {
      port: 0,
      databasePath: dbPath,
      seerrUrl: `http://127.0.0.1:${leakPort}`,
      seerrApiKey: superSecretApiKey,
      sessionSecret: secret,
      sessionTtlDays: 7,
    };

    const leakServer = http.createServer(async (req, res) => {
      if (await handleSeerrRequest(req, res, db, leakConfig)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => leakServer.listen(0, '127.0.0.1', () => r()));
    activeServers.push(leakServer);
    const leakServerPort = (leakServer.address() as { port: number }).port;

    const dupRes = await fetch(`http://127.0.0.1:${leakServerPort}/api/v1/seerr/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mediaType: 'movie', mediaId: 550 }),
    });

    assert.strictEqual(dupRes.status, 409);
    const dupData = (await dupRes.json()) as any;
    assert.strictEqual(
      dupData.error,
      'Media has already been requested or is already available'
    );
    assert.strictEqual(dupData.mediaId, 550);

    // CRITICAL SECURITY ASSERTION: Super secret key must NEVER be leaked in JSON response
    const rawResponseBody = JSON.stringify(dupData);
    assert.strictEqual(rawResponseBody.includes(superSecretApiKey), false);

    db.close();
  });
});
