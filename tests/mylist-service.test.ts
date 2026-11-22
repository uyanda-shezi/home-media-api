import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { signToken } from '../src/auth/crypto.js';
import { upsertUserAndCreateSession } from '../src/users/service.js';
import { handleMyListRequest } from '../src/mylist/router.js';
import {
  getUserPreferences,
  updateUserPreferences,
  upsertMediaItemAndWatchlist,
  removeWatchlistIntent,
  updatePlaybackState,
  updateAcquisitionState,
  getMyList,
  getMyListItem,
  getMyListStatus,
} from '../src/mylist/service.js';
import type { AppConfig } from '../src/config.js';

describe('Unified My List Engine & IDOR Security', () => {
  const activeServers: http.Server[] = [];
  const testDir = join(process.cwd(), 'tmp-test-mylist-service');
  const dbPath = join(testDir, 'mylist-service.db');
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

  it('enforces strict IDOR isolation, decoupled dimensions, and non-destructive intent removal', () => {
    const db = createDb(dbPath);
    runMigrations(db, './migrations');

    // Create User A (Alice) & User B (Bob)
    const userA = upsertUserAndCreateSession(db, {
      userId: 'jf-alice',
      username: 'Alice',
      isAdministrator: false,
      accessToken: 'token-alice',
    }).user;

    const userB = upsertUserAndCreateSession(db, {
      userId: 'jf-bob',
      username: 'Bob',
      isAdministrator: false,
      accessToken: 'token-bob',
    }).user;

    // 1. User A adds Fight Club to watchlist
    const itemA = upsertMediaItemAndWatchlist(db, userA.id, {
      media: {
        mediaType: 'movie',
        tmdbId: 550,
        title: 'Fight Club',
        posterPath: '/fc.jpg',
      },
      intent: 'saved',
    });
    assert.strictEqual(itemA.userIntent, 'saved');
    assert.strictEqual(itemA.acquisitionState, 'not_requested');
    assert.strictEqual(itemA.playbackState, 'unwatched');

    // IDOR Check: User B's list must be completely empty!
    const listB = getMyList(db, userB.id);
    assert.strictEqual(listB.total, 0);
    assert.strictEqual(listB.items.length, 0);

    const singleB = getMyListItem(db, userB.id, itemA.mediaId);
    assert.strictEqual(singleB, null);

    // IDOR Check: User B attempting to remove User A's item returns false
    const deleteAttemptByB = removeWatchlistIntent(db, userB.id, itemA.mediaId);
    assert.strictEqual(deleteAttemptByB, false);

    // 2. Playback State update (does NOT touch userIntent)
    updatePlaybackState(db, userA.id, itemA.mediaId, 'in_progress', 15420000000, 42.5);
    const itemAfterPlay = getMyListItem(db, userA.id, itemA.mediaId)!;
    assert.strictEqual(itemAfterPlay.playbackState, 'in_progress');
    assert.strictEqual(itemAfterPlay.playback.positionTicks, 15420000000);
    assert.strictEqual(itemAfterPlay.playback.percentage, 42.5);
    assert.strictEqual(itemAfterPlay.userIntent, 'saved'); // UNTOUCHED

    // 3. Acquisition State update (does NOT touch userIntent)
    updateAcquisitionState(db, itemA.mediaId, 'available');
    const itemAfterAcq = getMyListItem(db, userA.id, itemA.mediaId)!;
    assert.strictEqual(itemAfterAcq.acquisitionState, 'available');
    assert.strictEqual(itemAfterAcq.userIntent, 'saved'); // UNTOUCHED

    // 4. Non-destructive intent removal: user removes item from watchlist
    const removedByA = removeWatchlistIntent(db, userA.id, itemA.mediaId);
    assert.strictEqual(removedByA, true);

    // The item row is NOT dropped from SQLite!
    const itemAfterRemove = getMyListItem(db, userA.id, itemA.mediaId)!;
    assert.ok(itemAfterRemove !== null);
    assert.strictEqual(itemAfterRemove.userIntent, 'not_saved');
    // Historical playback and acquisition states remain 100% intact!
    assert.strictEqual(itemAfterRemove.acquisitionState, 'available');
    assert.strictEqual(itemAfterRemove.playbackState, 'in_progress');
    assert.strictEqual(itemAfterRemove.playback.positionTicks, 15420000000);

    // Filter check: default getMyList (intent=saved) returns 0
    const savedListA = getMyList(db, userA.id, { intent: 'saved' });
    assert.strictEqual(savedListA.total, 0);

    // Filter check: getMyList with intent=all or intent=not_saved returns the item
    const allListA = getMyList(db, userA.id, { intent: 'all' });
    assert.strictEqual(allListA.total, 1);
    assert.strictEqual(allListA.items[0].media.title, 'Fight Club');

    // 5. User Preferences
    const defaultPrefs = getUserPreferences(db, userA.id);
    assert.strictEqual(defaultPrefs.autoWatchlistRequests, true);

    const updatedPrefs = updateUserPreferences(db, userA.id, { autoWatchlistRequests: false });
    assert.strictEqual(updatedPrefs.autoWatchlistRequests, false);
    assert.strictEqual(getUserPreferences(db, userA.id).autoWatchlistRequests, false);

    db.close();
  });

  it('serves HTTP API endpoints with IDOR security, filters, and input validation', async () => {
    const db = createDb(dbPath);
    runMigrations(db, './migrations');

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

    const config: AppConfig = {
      port: 0,
      databasePath: dbPath,
      sessionSecret: secret,
      sessionTtlDays: 7,
    };

    const server = http.createServer(async (req, res) => {
      if (await handleMyListRequest(req, res, db, config)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    activeServers.push(server);
    const port = (server.address() as { port: number }).port;

    // 1. Unauthenticated request returns 401
    const unauthRes = await fetch(`http://127.0.0.1:${port}/api/v1/my-list`);
    assert.strictEqual(unauthRes.status, 401);

    // 2. Alice adds a movie via POST /api/v1/my-list/items
    const addRes = await fetch(`http://127.0.0.1:${port}/api/v1/my-list/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({
        mediaType: 'movie',
        tmdbId: 550,
        title: 'Fight Club',
        posterPath: '/fc.jpg',
        intent: 'saved',
      }),
    });
    assert.strictEqual(addRes.status, 200);
    const addData = (await addRes.json()) as any;
    assert.strictEqual(addData.status, 'ok');
    assert.strictEqual(addData.item.media.title, 'Fight Club');
    const mediaId = addData.item.mediaId;

    // 3. Alice adds a series
    await fetch(`http://127.0.0.1:${port}/api/v1/my-list/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({
        mediaType: 'series',
        tmdbId: 119051,
        title: 'Wednesday',
        intent: 'saved',
      }),
    });

    // 4. Bob queries GET /api/v1/my-list -> must see 0 items (IDOR protection)
    const bobListRes = await fetch(`http://127.0.0.1:${port}/api/v1/my-list`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    assert.strictEqual(bobListRes.status, 200);
    const bobListData = (await bobListRes.json()) as any;
    assert.strictEqual(bobListData.total, 0);

    // Bob cannot inspect Alice's single item
    const bobSingleRes = await fetch(`http://127.0.0.1:${port}/api/v1/my-list/${mediaId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    assert.strictEqual(bobSingleRes.status, 404);

    // Bob cannot delete Alice's item
    const bobDeleteRes = await fetch(`http://127.0.0.1:${port}/api/v1/my-list/items/${mediaId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    assert.strictEqual(bobDeleteRes.status, 404);

    // 5. Alice queries GET /api/v1/my-list with filtering
    const aliceListRes = await fetch(
      `http://127.0.0.1:${port}/api/v1/my-list?mediaType=movie`,
      {
        headers: { Authorization: `Bearer ${aliceToken}` },
      }
    );
    assert.strictEqual(aliceListRes.status, 200);
    const aliceListData = (await aliceListRes.json()) as any;
    assert.strictEqual(aliceListData.total, 1);
    assert.strictEqual(aliceListData.items[0].media.title, 'Fight Club');

    // 6. Status check via GET /api/v1/my-list/status/:mediaId
    const statusRes = await fetch(`http://127.0.0.1:${port}/api/v1/my-list/status/${mediaId}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    assert.strictEqual(statusRes.status, 200);
    const statusData = (await statusRes.json()) as any;
    assert.strictEqual(statusData.userIntent, 'saved');
    assert.strictEqual(statusData.acquisitionState, 'not_requested');

    // Status check by query params: ?tmdbId=550&mediaType=movie
    const statusByQueryRes = await fetch(
      `http://127.0.0.1:${port}/api/v1/my-list/status?tmdbId=550&mediaType=movie`,
      {
        headers: { Authorization: `Bearer ${aliceToken}` },
      }
    );
    assert.strictEqual(statusByQueryRes.status, 200);
    const statusByQueryData = (await statusByQueryRes.json()) as any;
    assert.strictEqual(statusByQueryData.mediaId, mediaId);
    assert.strictEqual(statusByQueryData.userIntent, 'saved');

    // 7. Input validation: rejecting individual 'season' or 'episode'
    const invalidSeasonRes = await fetch(`http://127.0.0.1:${port}/api/v1/my-list/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({
        mediaType: 'season',
        tmdbId: 1234,
        title: 'Season 1',
      }),
    });
    assert.strictEqual(invalidSeasonRes.status, 400);

    // 8. Alice removes item from watchlist via DELETE /api/v1/my-list/items/:mediaId
    const deleteRes = await fetch(`http://127.0.0.1:${port}/api/v1/my-list/items/${mediaId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    assert.strictEqual(deleteRes.status, 200);
    const deleteData = (await deleteRes.json()) as any;
    assert.strictEqual(deleteData.status, 'removed');
    assert.strictEqual(deleteData.userIntent, 'not_saved');

    // 9. Preferences endpoint: GET and PATCH /api/v1/users/me/preferences
    const getPrefRes = await fetch(`http://127.0.0.1:${port}/api/v1/users/me/preferences`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    assert.strictEqual(getPrefRes.status, 200);
    const prefData = (await getPrefRes.json()) as any;
    assert.strictEqual(prefData.autoWatchlistRequests, true);

    const patchPrefRes = await fetch(`http://127.0.0.1:${port}/api/v1/users/me/preferences`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ autoWatchlistRequests: false }),
    });
    assert.strictEqual(patchPrefRes.status, 200);
    const patchPrefData = (await patchPrefRes.json()) as any;
    assert.strictEqual(patchPrefData.preferences.autoWatchlistRequests, false);

    db.close();
  });
});
