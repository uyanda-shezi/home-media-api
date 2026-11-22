import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { signToken } from '../src/auth/crypto.js';
import { upsertUserAndCreateSession } from '../src/users/service.js';
import { handleSeerrRequest } from '../src/seerr/router.js';
import {
  getUserPreferences,
  updateUserPreferences,
  getMyListItem,
  getMyListStatus,
  upsertMediaItemAndWatchlist,
  removeWatchlistIntent,
} from '../src/mylist/service.js';
import type { AppConfig } from '../src/config.js';

describe('Automatic Watchlist Addition on Seerr Request & Intent Preservation', () => {
  const activeServers: http.Server[] = [];
  const testDir = join(process.cwd(), 'tmp-test-seerr-hook');
  const dbPath = join(testDir, 'seerr-hook.db');
  const secret = 'test_secret_key_at_least_32_chars_long_12345';
  const apiKey = 'test-seerr-api-key-12345';

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

  it('automatically adds to watchlist respecting preferences and strictly preserving explicit user intent', async () => {
    let capturedSeerrRequestId = 100;

    // 1. Mock upstream Seerr server
    const mockSeerr = http.createServer((req, res) => {
      const url = req.url || '';
      const method = req.method || 'GET';

      if (url.startsWith('/api/v1/user')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            results: [
              { id: 1, username: 'alice', jellyfinUserId: 'jf-alice' },
              { id: 2, username: 'bob', jellyfinUserId: 'jf-bob' },
            ],
          })
        );
        return;
      }

      if (url === '/api/v1/request' && method === 'POST') {
        capturedSeerrRequestId += 1;
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: capturedSeerrRequestId,
              status: 1, // Pending
              type: parsed.mediaType,
              media: {
                id: 50,
                tmdbId: parsed.mediaId,
                mediaType: parsed.mediaType,
                title: parsed.mediaType === 'movie' ? 'Inception' : 'Severance',
                posterPath: '/poster.jpg',
                status: 2,
              },
              requestedBy: {
                id: parsed.userId || 1,
                username: 'alice',
                jellyfinUserId: 'jf-alice',
              },
              createdAt: '2026-11-22T12:00:00Z',
            })
          );
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((r) => mockSeerr.listen(0, '127.0.0.1', () => r()));
    activeServers.push(mockSeerr);
    const seerrPort = (mockSeerr.address() as { port: number }).port;

    const db = createDb(dbPath);
    runMigrations(db, './migrations');

    // Alice: autoWatchlistRequests = true (default)
    const aliceCtx = upsertUserAndCreateSession(db, {
      userId: 'jf-alice',
      username: 'Alice',
      isAdministrator: true,
      accessToken: 'token-alice',
    });
    const aliceToken = signToken(
      { sid: aliceCtx.session.id, uid: aliceCtx.user.id, exp: Date.now() + 3600_000 },
      secret
    );

    // Bob: sets autoWatchlistRequests = false
    const bobCtx = upsertUserAndCreateSession(db, {
      userId: 'jf-bob',
      username: 'Bob',
      isAdministrator: false,
      accessToken: 'token-bob',
    });
    const bobToken = signToken(
      { sid: bobCtx.session.id, uid: bobCtx.user.id, exp: Date.now() + 3600_000 },
      secret
    );
    updateUserPreferences(db, bobCtx.user.id, { autoWatchlistRequests: false });

    const config: AppConfig = {
      port: 0,
      databasePath: dbPath,
      seerrUrl: `http://127.0.0.1:${seerrPort}`,
      seerrApiKey: apiKey,
      sessionSecret: secret,
      sessionTtlDays: 7,
    };

    const server = http.createServer(async (req, res) => {
      if (await handleSeerrRequest(req, res, db, config)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    activeServers.push(server);
    const port = (server.address() as { port: number }).port;

    // --- TEST 1: Alice requests Inception (autoWatchlist = true) ---
    // Item is newly requested and added to My List with user_intent = 'saved'
    const aliceReqRes = await fetch(`http://127.0.0.1:${port}/api/v1/seerr/requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ mediaType: 'movie', mediaId: 27205 }),
    });
    assert.strictEqual(aliceReqRes.status, 201);

    const aliceStatus = getMyListStatus(db, aliceCtx.user.id, {
      tmdbId: 27205,
      mediaType: 'movie',
    });
    assert.strictEqual(aliceStatus.userIntent, 'saved');
    assert.strictEqual(aliceStatus.acquisitionState, 'pending');
    assert.ok(aliceStatus.mediaId !== null);

    // --- TEST 2: Bob requests Severance (autoWatchlist = false) ---
    // Item is newly requested and added to My List with user_intent = 'not_saved'
    const bobReqRes = await fetch(`http://127.0.0.1:${port}/api/v1/seerr/requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bobToken}`,
      },
      body: JSON.stringify({ mediaType: 'tv', mediaId: 95396, seasons: [1] }),
    });
    assert.strictEqual(bobReqRes.status, 201);

    const bobStatus = getMyListStatus(db, bobCtx.user.id, {
      tmdbId: 95396,
      mediaType: 'series',
    });
    assert.strictEqual(bobStatus.userIntent, 'not_saved');
    assert.strictEqual(bobStatus.acquisitionState, 'pending');

    // --- TEST 3: CRITICAL NON-DESTRUCTIVE INTENT PRESERVATION ---
    // Alice had previously marked The Matrix as 'not_saved' (removed from watchlist)
    const matrixItem = upsertMediaItemAndWatchlist(db, aliceCtx.user.id, {
      media: {
        mediaType: 'movie',
        tmdbId: 603,
        title: 'The Matrix',
      },
      intent: 'saved',
    });
    removeWatchlistIntent(db, aliceCtx.user.id, matrixItem.mediaId);

    // Verify it is currently 'not_saved'
    const beforeReqStatus = getMyListStatus(db, aliceCtx.user.id, { mediaId: matrixItem.mediaId });
    assert.strictEqual(beforeReqStatus.userIntent, 'not_saved');

    // Now Alice requests The Matrix via Seerr
    const matrixReqRes = await fetch(`http://127.0.0.1:${port}/api/v1/seerr/requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ mediaType: 'movie', mediaId: 603 }),
    });
    assert.strictEqual(matrixReqRes.status, 201);

    // CRITICAL ASSERTION: The hook must update acquisition_state to 'pending',
    // but MUST LEAVE user_intent as 'not_saved'!
    const afterReqStatus = getMyListStatus(db, aliceCtx.user.id, { mediaId: matrixItem.mediaId });
    assert.strictEqual(afterReqStatus.acquisitionState, 'pending');
    assert.strictEqual(afterReqStatus.userIntent, 'not_saved'); // PRESERVED!

    db.close();
  });
});
