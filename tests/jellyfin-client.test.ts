import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { signToken } from '../src/auth/crypto.js';
import { upsertUserAndCreateSession } from '../src/users/service.js';
import { handleJellyfinRequest } from '../src/jellyfin/router.js';
import type { AppConfig } from '../src/config.js';

describe('Jellyfin Integration Client & Endpoints', () => {
  const activeServers: http.Server[] = [];
  const testDir = join(process.cwd(), 'tmp-test-jellyfin-client');
  const dbPath = join(testDir, 'jf-client.db');
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

  it('handles library discovery, listing, search, item details, availability, and playback sync with path sanitization', async () => {
    let capturedProgressBody: any = null;
    let capturedPlayedMethod = '';

    // 1. Mock Upstream Jellyfin Server
    const mockJellyfin = http.createServer((req, res) => {
      const url = req.url || '';
      const method = req.method || 'GET';

      // Verify X-Emby-Token is passed
      assert.strictEqual(req.headers['x-emby-token'], 'jf-session-token-abc');

      // A. Libraries Discovery
      if (url.startsWith('/Users/jf-user-1/Views') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            Items: [
              { Id: 'lib-movies-1', Name: 'Movies', CollectionType: 'movies' },
              { Id: 'lib-tv-1', Name: 'TV Shows', CollectionType: 'tvshows' },
            ],
          })
        );
        return;
      }

      // B. Library Items Listing
      if (url.startsWith('/Users/jf-user-1/Items') && url.includes('ParentId=lib-movies-1') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            TotalRecordCount: 1,
            Items: [
              {
                Id: 'item-movie-1',
                Name: 'Inception',
                Type: 'Movie',
                ProductionYear: 2010,
                Overview: 'Dream thieves...',
                CommunityRating: 8.4,
                Path: '/mnt/storage/movies/Inception (2010)/Inception.mkv', // MUST BE STRIPPED
                ProviderIds: { Tmdb: '27205', Imdb: 'tt1375666' },
                UserData: { Played: true, PlaybackPositionTicks: 0 },
              },
            ],
          })
        );
        return;
      }

      // C. Unified Search
      if (url.startsWith('/Users/jf-user-1/Items') && url.includes('SearchTerm=Inception') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            TotalRecordCount: 1,
            Items: [
              {
                Id: 'item-movie-1',
                Name: 'Inception',
                Type: 'Movie',
                ProductionYear: 2010,
                Overview: 'Dream thieves...',
                Path: '/mnt/storage/movies/Inception.mkv', // MUST BE STRIPPED
                ProviderIds: { Tmdb: '27205' },
              },
            ],
          })
        );
        return;
      }

      // D. Availability Check by Provider ID
      if (url.startsWith('/Users/jf-user-1/Items') && url.includes('AnyProviderIdEquals=Tmdb.27205') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            Items: [
              {
                Id: 'item-movie-1',
                Name: 'Inception',
                Type: 'Movie',
                ProductionYear: 2010,
                ProviderIds: { Tmdb: '27205' },
              },
            ],
          })
        );
        return;
      }

      // Availability check for not-found
      if (url.startsWith('/Users/jf-user-1/Items') && url.includes('AnyProviderIdEquals=Tmdb.999999') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Items: [] }));
        return;
      }

      // E. Media Details (Series with Seasons)
      if (url.startsWith('/Users/jf-user-1/Items/series-bb-1') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            Id: 'series-bb-1',
            Name: 'Breaking Bad',
            Type: 'Series',
            ProductionYear: 2008,
            Overview: 'Chemistry teacher...',
            Path: '/mnt/storage/tv/Breaking Bad', // MUST BE STRIPPED
            ProviderIds: { Tvdb: '81189' },
            MediaStreams: [
              { Type: 'Video', Codec: 'hevc', Width: 1920, Height: 1080 },
              { Type: 'Audio', Codec: 'aac', Channels: 6, Language: 'eng', Title: '5.1 Surround' },
              { Type: 'Subtitle', Codec: 'subrip', Language: 'eng', Title: 'English' },
            ],
          })
        );
        return;
      }

      // E2. Seasons lookup for series
      if (url.startsWith('/Shows/series-bb-1/Seasons') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            Items: [
              { Id: 'season-1', Name: 'Season 1', IndexNumber: 1, EpisodeCount: 7 },
              { Id: 'season-2', Name: 'Season 2', IndexNumber: 2, EpisodeCount: 13 },
            ],
          })
        );
        return;
      }

      // F. Playback Info Query
      if (url.startsWith('/Users/jf-user-1/Items/item-movie-1') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            Id: 'item-movie-1',
            Name: 'Inception',
            RunTimeTicks: 88800000000,
            Path: '/mnt/storage/movies/Inception.mkv', // MUST BE STRIPPED
            UserData: { PlaybackPositionTicks: 15420000000, Played: false },
            MediaStreams: [
              { Type: 'Audio', Index: 1, Language: 'eng', Codec: 'truehd', Title: 'TrueHD 7.1' },
              { Type: 'Subtitle', Index: 2, Language: 'eng', Codec: 'subrip', Title: 'English SDH' },
            ],
          })
        );
        return;
      }

      // G. Progress Reporting
      if (url === '/Sessions/Playing/Progress' && method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          capturedProgressBody = JSON.parse(body);
          res.writeHead(204).end();
        });
        return;
      }

      // H. Played Status Toggle
      if (url.startsWith('/Users/jf-user-1/PlayedItems/item-movie-1')) {
        capturedPlayedMethod = method;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Played: method === 'POST' }));
        return;
      }

      res.writeHead(404).end();
    });

    await new Promise<void>((r) => mockJellyfin.listen(0, '127.0.0.1', () => r()));
    activeServers.push(mockJellyfin);
    const jfPort = (mockJellyfin.address() as { port: number }).port;

    // 2. Setup SQLite Database & Standard User Session
    const db = createDb(dbPath);
    try {
      runMigrations(db, './migrations');

      const userCtx = upsertUserAndCreateSession(db, {
        userId: 'jf-user-1',
        username: 'TestUser',
        isAdministrator: false,
        accessToken: 'jf-session-token-abc',
      });

      const authToken = signToken(
        { sid: userCtx.session.id, uid: userCtx.user.id, exp: Date.now() + 3600_000 },
        secret
      );

      const config: AppConfig = {
        port: 3000,
        databasePath: dbPath,
        jellyfinUrl: `http://127.0.0.1:${jfPort}`,
        jellyfinPublicUrl: 'http://media.lan:8096',
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

      // TEST 1: GET /api/v1/jellyfin/libraries
      const resLibs = await fetch(`${baseUrl}/api/v1/jellyfin/libraries`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.strictEqual(resLibs.status, 200);
      const dataLibs = (await resLibs.json()) as any;
      assert.strictEqual(dataLibs.libraries.length, 2);
      assert.strictEqual(dataLibs.libraries[0].name, 'Movies');
      assert.strictEqual(dataLibs.libraries[0].collectionType, 'movies');

      // TEST 2: GET /api/v1/jellyfin/libraries/:id/items
      const resItems = await fetch(`${baseUrl}/api/v1/jellyfin/libraries/lib-movies-1/items?limit=10`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.strictEqual(resItems.status, 200);
      const dataItems = (await resItems.json()) as any;
      assert.strictEqual(dataItems.totalRecordCount, 1);
      assert.strictEqual(dataItems.items[0].name, 'Inception');
      // Verify Path is completely omitted
      assert.strictEqual(dataItems.items[0].Path, undefined);
      assert.strictEqual(dataItems.items[0].path, undefined);

      // TEST 3: GET /api/v1/jellyfin/search
      const resSearch = await fetch(`${baseUrl}/api/v1/jellyfin/search?q=Inception&type=movie`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.strictEqual(resSearch.status, 200);
      const dataSearch = (await resSearch.json()) as any;
      assert.strictEqual(dataSearch.query, 'Inception');
      assert.strictEqual(dataSearch.items.length, 1);
      assert.strictEqual(dataSearch.items[0].name, 'Inception');
      assert.strictEqual(dataSearch.items[0].Path, undefined);

      // TEST 4: GET /api/v1/jellyfin/availability
      // 4A: Available
      const resAvail = await fetch(`${baseUrl}/api/v1/jellyfin/availability?tmdbId=27205`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.strictEqual(resAvail.status, 200);
      const dataAvail = (await resAvail.json()) as any;
      assert.strictEqual(dataAvail.available, true);
      assert.strictEqual(dataAvail.jellyfinId, 'item-movie-1');
      assert.strictEqual(dataAvail.name, 'Inception');

      // 4B: Not available
      const resNotAvail = await fetch(`${baseUrl}/api/v1/jellyfin/availability?tmdbId=999999`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.strictEqual(resNotAvail.status, 200);
      const dataNotAvail = (await resNotAvail.json()) as any;
      assert.strictEqual(dataNotAvail.available, false);
      assert.strictEqual(dataNotAvail.jellyfinId, null);

      // TEST 5: GET /api/v1/jellyfin/items/:id (with includeSeasons=true)
      const resDetails = await fetch(`${baseUrl}/api/v1/jellyfin/items/series-bb-1?includeSeasons=true`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.strictEqual(resDetails.status, 200);
      const dataDetails = (await resDetails.json()) as any;
      assert.strictEqual(dataDetails.name, 'Breaking Bad');
      assert.strictEqual(dataDetails.type, 'Series');
      assert.strictEqual(dataDetails.Path, undefined);
      assert.strictEqual(dataDetails.seasons.length, 2);
      assert.strictEqual(dataDetails.seasons[0].name, 'Season 1');

      // TEST 6: GET /api/v1/jellyfin/items/:id/playback
      const resPlayback = await fetch(`${baseUrl}/api/v1/jellyfin/items/item-movie-1/playback`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.strictEqual(resPlayback.status, 200);
      const dataPlayback = (await resPlayback.json()) as any;
      assert.strictEqual(dataPlayback.name, 'Inception');
      assert.strictEqual(dataPlayback.playbackPositionTicks, 15420000000);
      // Verify public URL and session token in streamUrl
      assert.strictEqual(
        dataPlayback.streamUrl,
        'http://media.lan:8096/Videos/item-movie-1/stream?static=true&api_key=jf-session-token-abc'
      );
      assert.strictEqual(
        dataPlayback.deepLinks.web,
        'http://media.lan:8096/web/index.html#!/details?id=item-movie-1'
      );
      assert.strictEqual(dataPlayback.deepLinks.app, 'jellyfin://item?id=item-movie-1');
      assert.strictEqual(dataPlayback.audioTracks.length, 1);
      assert.strictEqual(dataPlayback.audioTracks[0].title, 'TrueHD 7.1');
      assert.strictEqual(dataPlayback.audioTracks[0].Path, undefined);

      // TEST 7: POST /api/v1/jellyfin/items/:id/progress
      const resProgress = await fetch(`${baseUrl}/api/v1/jellyfin/items/item-movie-1/progress`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          positionTicks: 25000000000,
          isPaused: false,
          event: 'progress',
        }),
      });
      assert.strictEqual(resProgress.status, 200);
      const dataProgress = (await resProgress.json()) as any;
      assert.strictEqual(dataProgress.status, 'ok');
      assert.strictEqual(dataProgress.positionTicks, 25000000000);
      assert.strictEqual(capturedProgressBody?.PositionTicks, 25000000000);

      // TEST 8: POST /api/v1/jellyfin/items/:id/played
      // 8A. Mark played = true -> sends POST
      const resPlayedTrue = await fetch(`${baseUrl}/api/v1/jellyfin/items/item-movie-1/played`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ played: true }),
      });
      assert.strictEqual(resPlayedTrue.status, 200);
      assert.strictEqual(capturedPlayedMethod, 'POST');

      // 8B. Mark played = false -> sends DELETE
      const resPlayedFalse = await fetch(`${baseUrl}/api/v1/jellyfin/items/item-movie-1/played`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ played: false }),
      });
      assert.strictEqual(resPlayedFalse.status, 200);
      assert.strictEqual(capturedPlayedMethod, 'DELETE');
    } finally {
      db.close();
    }
  });
});
