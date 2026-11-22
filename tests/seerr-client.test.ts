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

describe('Seerr Integration Client & Endpoints', () => {
  const activeServers: http.Server[] = [];
  const testDir = join(process.cwd(), 'tmp-test-seerr-client');
  const dbPath = join(testDir, 'seerr-client.db');
  const secret = 'test_secret_key_at_least_32_chars_long_12345';
  const testApiKey = 'mock-seerr-api-key-xyz123';

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

  it('handles search, trending, media details, request lifecycle, permissions, and anti-spoofing', async () => {
    let capturedRequestPayload: any = null;
    let approvedRequestId = 0;
    let declinedRequestId = 0;
    let deletedRequestId = 0;

    // 1. Mock Upstream Seerr Server
    const mockSeerr = http.createServer((req, res) => {
      const url = req.url || '';
      const method = req.method || 'GET';

      // Verify X-Api-Key is passed on every upstream call
      assert.strictEqual(req.headers['x-api-key'], testApiKey);

      // A. User Directory
      if (url.startsWith('/api/v1/user') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            pageInfo: { pages: 1, pageSize: 50, results: 2, page: 1 },
            results: [
              {
                id: 1,
                username: 'alice',
                email: 'alice@local',
                jellyfinUserId: 'jf-admin-guid-1',
              },
              {
                id: 2,
                username: 'bob',
                email: 'bob@local',
                jellyfinUserId: 'jf-standard-guid-2',
              },
            ],
          })
        );
        return;
      }

      // B. Search
      if (url.startsWith('/api/v1/search') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            page: 1,
            totalPages: 1,
            totalResults: 2,
            results: [
              {
                id: 550,
                mediaType: 'movie',
                title: 'Fight Club',
                overview: 'An insomniac office worker...',
                posterPath: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
                backdropPath: '/hZkgoQYus5vegHoetLkCJzb17zJ.jpg',
                releaseDate: '1999-10-15',
                voteAverage: 8.4,
                mediaInfo: {
                  id: 12,
                  tmdbId: 550,
                  status: 5, // Available
                  requests: [{ id: 42, status: 2 }],
                },
              },
              {
                id: 99999,
                mediaType: 'person',
                name: 'Brad Pitt',
              },
            ],
          })
        );
        return;
      }

      // C. Trending Discovery
      if (url.startsWith('/api/v1/discover/trending') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            page: 1,
            totalPages: 10,
            totalResults: 200,
            results: [
              {
                id: 119051,
                mediaType: 'tv',
                name: 'Wednesday',
                overview: 'Wednesday Addams...',
                posterPath: '/9PFonQ9cc0HQdaKiLflvtL0nRY8.jpg',
                firstAirDate: '2022-11-23',
                voteAverage: 8.5,
                mediaInfo: {
                  id: 14,
                  tmdbId: 119051,
                  status: 2, // Pending
                },
              },
            ],
          })
        );
        return;
      }

      // D. Media Details (Movie)
      if (url === '/api/v1/movie/550' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 550,
            title: 'Fight Club',
            overview: 'An insomniac office worker...',
            posterPath: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
            backdropPath: '/hZkgoQYus5vegHoetLkCJzb17zJ.jpg',
            releaseDate: '1999-10-15',
            genres: [{ id: 18, name: 'Drama' }, { id: 53, name: 'Thriller' }],
            voteAverage: 8.4,
            status: 'Released',
            mediaInfo: {
              id: 12,
              tmdbId: 550,
              status: 5,
              requests: [
                {
                  id: 42,
                  status: 2,
                  requestedBy: {
                    id: 1,
                    username: 'alice',
                    jellyfinUserId: 'jf-admin-guid-1',
                  },
                  createdAt: '2026-11-10T14:20:00Z',
                },
              ],
            },
          })
        );
        return;
      }

      // E. Media Details (TV)
      if (url === '/api/v1/tv/119051' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 119051,
            name: 'Wednesday',
            overview: 'Wednesday Addams...',
            posterPath: '/9PFonQ9cc0HQdaKiLflvtL0nRY8.jpg',
            firstAirDate: '2022-11-23',
            genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }],
            voteAverage: 8.5,
            status: 'Returning Series',
            mediaInfo: {
              id: 14,
              tmdbId: 119051,
              status: 2,
            },
          })
        );
        return;
      }

      // F. Submit Request (POST /api/v1/request)
      if (url === '/api/v1/request' && method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          capturedRequestPayload = JSON.parse(body);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 43,
              status: 1, // Pending
              type: capturedRequestPayload.mediaType,
              media: {
                id: 15,
                tmdbId: capturedRequestPayload.mediaId,
                mediaType: capturedRequestPayload.mediaType,
                status: 2,
              },
              requestedBy: {
                id: capturedRequestPayload.userId || 1,
                username: capturedRequestPayload.userId === 2 ? 'bob' : 'alice',
                jellyfinUserId:
                  capturedRequestPayload.userId === 2
                    ? 'jf-standard-guid-2'
                    : 'jf-admin-guid-1',
              },
              seasons: capturedRequestPayload.seasons,
              createdAt: '2026-11-22T11:00:00Z',
            })
          );
        });
        return;
      }

      // G. Request List (GET /api/v1/request)
      if (url.startsWith('/api/v1/request?') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            pageInfo: { pages: 1, pageSize: 20, results: 2, page: 1 },
            results: [
              {
                id: 42,
                status: 2, // Approved
                type: 'movie',
                media: {
                  id: 12,
                  tmdbId: 550,
                  title: 'Fight Club',
                  status: 5,
                },
                requestedBy: {
                  id: 1,
                  username: 'alice',
                  jellyfinUserId: 'jf-admin-guid-1',
                },
                createdAt: '2026-11-10T14:20:00Z',
              },
              {
                id: 43,
                status: 1, // Pending
                type: 'tv',
                media: {
                  id: 14,
                  tmdbId: 119051,
                  title: 'Wednesday',
                  status: 2,
                },
                requestedBy: {
                  id: 2,
                  username: 'bob',
                  jellyfinUserId: 'jf-standard-guid-2',
                },
                seasons: [1, 2],
                createdAt: '2026-11-22T11:00:00Z',
              },
            ],
          })
        );
        return;
      }

      // H. Single Request (GET /api/v1/request/:id)
      const singleReqMatch = url.match(/^\/api\/v1\/request\/(\d+)$/);
      if (singleReqMatch && method === 'GET') {
        const id = parseInt(singleReqMatch[1], 10);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id,
            status: 1, // Pending
            type: 'tv',
            media: {
              id: 14,
              tmdbId: 119051,
              title: 'Wednesday',
              status: 2,
            },
            requestedBy: {
              id: 2,
              username: 'bob',
              jellyfinUserId: 'jf-standard-guid-2',
            },
            seasons: [1, 2],
            createdAt: '2026-11-22T11:00:00Z',
          })
        );
        return;
      }

      // I. Approve Request (POST /api/v1/request/:id/approve)
      const approveMatch = url.match(/^\/api\/v1\/request\/(\d+)\/approve$/);
      if (approveMatch && method === 'POST') {
        approvedRequestId = parseInt(approveMatch[1], 10);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: approvedRequestId,
            status: 2,
          })
        );
        return;
      }

      // J. Decline Request (POST /api/v1/request/:id/decline)
      const declineMatch = url.match(/^\/api\/v1\/request\/(\d+)\/decline$/);
      if (declineMatch && method === 'POST') {
        declinedRequestId = parseInt(declineMatch[1], 10);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: declinedRequestId,
            status: 3,
          })
        );
        return;
      }

      // K. Delete Request (DELETE /api/v1/request/:id)
      const deleteMatch = url.match(/^\/api\/v1\/request\/(\d+)$/);
      if (deleteMatch && method === 'DELETE') {
        deletedRequestId = parseInt(deleteMatch[1], 10);
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

    // 2. Setup SQLite database and users
    const db = createDb(dbPath);
    runMigrations(db, './migrations');

    // Admin user (Alice)
    const adminCtx = upsertUserAndCreateSession(db, {
      userId: 'jf-admin-guid-1',
      username: 'Alice',
      isAdministrator: true,
      accessToken: 'jf-token-admin',
    });
    const adminToken = signToken(
      { sid: adminCtx.session.id, uid: adminCtx.user.id, exp: Date.now() + 3600_000 },
      secret
    );

    // Standard user (Bob)
    const standardCtx = upsertUserAndCreateSession(db, {
      userId: 'jf-standard-guid-2',
      username: 'Bob',
      isAdministrator: false,
      accessToken: 'jf-token-standard',
    });
    const standardToken = signToken(
      { sid: standardCtx.session.id, uid: standardCtx.user.id, exp: Date.now() + 3600_000 },
      secret
    );

    // 3. Test HTTP Server
    const config: AppConfig = {
      port: 0,
      databasePath: dbPath,
      seerrUrl: `http://127.0.0.1:${seerrPort}`,
      seerrApiKey: testApiKey,
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

    // --- TEST 1: Search ---
    const searchRes = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/search?q=Fight+Club&type=movie`,
      {
        headers: { Authorization: `Bearer ${standardToken}` },
      }
    );
    assert.strictEqual(searchRes.status, 200);
    const searchData = (await searchRes.json()) as any;
    assert.strictEqual(searchData.page, 1);
    assert.strictEqual(searchData.results.length, 1);
    assert.strictEqual(searchData.results[0].title, 'Fight Club');
    assert.strictEqual(searchData.results[0].mediaType, 'movie');
    assert.strictEqual(searchData.results[0].mediaInfo.status, 'available');
    assert.strictEqual(searchData.results[0].mediaInfo.requestId, 42);

    // --- TEST 2: Trending ---
    const trendingRes = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/discover/trending?page=1`,
      {
        headers: { Authorization: `Bearer ${standardToken}` },
      }
    );
    assert.strictEqual(trendingRes.status, 200);
    const trendingData = (await trendingRes.json()) as any;
    assert.strictEqual(trendingData.results.length, 1);
    assert.strictEqual(trendingData.results[0].title, 'Wednesday');
    assert.strictEqual(trendingData.results[0].mediaType, 'tv');
    assert.strictEqual(trendingData.results[0].mediaInfo.status, 'pending');

    // --- TEST 3: Media Details (Movie) ---
    const movieDetailsRes = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/media/movie/550`,
      {
        headers: { Authorization: `Bearer ${standardToken}` },
      }
    );
    assert.strictEqual(movieDetailsRes.status, 200);
    const movieData = (await movieDetailsRes.json()) as any;
    assert.strictEqual(movieData.id, 550);
    assert.strictEqual(movieData.mediaType, 'movie');
    assert.deepStrictEqual(movieData.genres, ['Drama', 'Thriller']);
    assert.strictEqual(movieData.mediaInfo.status, 'available');
    assert.strictEqual(movieData.mediaInfo.requests[0].requestedBy.username, 'alice');

    // --- TEST 4: Request Submission with Anti-Spoofing ---
    // Bob sends a request but attempts to spoof userId: 999
    const reqSubmitRes = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/requests`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${standardToken}`,
        },
        body: JSON.stringify({
          mediaType: 'movie',
          mediaId: 550,
          userId: 999, // Attempted spoof
        }),
      }
    );
    assert.strictEqual(reqSubmitRes.status, 201);
    const reqSubmitData = (await reqSubmitRes.json()) as any;
    assert.strictEqual(reqSubmitData.id, 43);
    assert.strictEqual(reqSubmitData.status, 'pending');
    assert.strictEqual(reqSubmitData.requestedBy.username, 'bob');

    // Verify upstream received Bob's resolved Seerr userId: 2 (NOT the spoofed 999)
    assert.strictEqual(capturedRequestPayload.userId, 2);
    assert.strictEqual(capturedRequestPayload.mediaType, 'movie');
    assert.strictEqual(capturedRequestPayload.mediaId, 550);

    // --- TEST 5: TV Request Submission with Seasons ---
    const tvReqRes = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/requests`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${standardToken}`,
        },
        body: JSON.stringify({
          mediaType: 'tv',
          mediaId: 119051,
          seasons: [1, 2],
        }),
      }
    );
    assert.strictEqual(tvReqRes.status, 201);
    assert.deepStrictEqual(capturedRequestPayload.seasons, [1, 2]);

    // --- TEST 6: List Requests with user=me scoping ---
    const listRes = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/requests?user=me`,
      {
        headers: { Authorization: `Bearer ${standardToken}` },
      }
    );
    assert.strictEqual(listRes.status, 200);
    const listData = (await listRes.json()) as any;
    // Should filter to Bob's requests only
    assert.strictEqual(listData.requests.length, 1);
    assert.strictEqual(listData.requests[0].id, 43);
    assert.strictEqual(listData.requests[0].requestedBy.username, 'bob');

    // --- TEST 7: Single Request Retrieval ---
    const singleReqRes = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/requests/43`,
      {
        headers: { Authorization: `Bearer ${standardToken}` },
      }
    );
    assert.strictEqual(singleReqRes.status, 200);
    const singleReqData = (await singleReqRes.json()) as any;
    assert.strictEqual(singleReqData.id, 43);
    assert.strictEqual(singleReqData.status, 'pending');

    // --- TEST 8: Approve Request (Admin Only) ---
    const approveRes = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/requests/43/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    assert.strictEqual(approveRes.status, 200);
    const approveData = (await approveRes.json()) as any;
    assert.strictEqual(approveData.id, 43);
    assert.strictEqual(approveData.status, 'approved');
    assert.strictEqual(approvedRequestId, 43);

    // --- TEST 9: Decline Request (Admin Only) ---
    const declineRes = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/requests/43/decline`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    assert.strictEqual(declineRes.status, 200);
    const declineData = (await declineRes.json()) as any;
    assert.strictEqual(declineData.id, 43);
    assert.strictEqual(declineData.status, 'declined');
    assert.strictEqual(declinedRequestId, 43);

    // --- TEST 10: Delete Request by Owner (Bob) ---
    const deleteRes = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/seerr/requests/43`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${standardToken}` },
      }
    );
    assert.strictEqual(deleteRes.status, 200);
    const deleteData = (await deleteRes.json()) as any;
    assert.strictEqual(deleteData.status, 'deleted');
    assert.strictEqual(deleteData.requestId, 43);
    assert.strictEqual(deletedRequestId, 43);

    db.close();
  });
});
