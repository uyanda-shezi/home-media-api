import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { reconcilePass, type SyncSource } from '../src/sync/reconcile.js';

const guid = 'abcdef011234567890abcdef01234567';
const dashed = 'ABCDEF01-1234-5678-90AB-CDEF01234567';

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'home-media-sync-'));
  const path = join(dir, 'db.sqlite');
  const db = createDb(path);
  runMigrations(db);
  db.exec(`
    INSERT INTO users (id, jellyfin_user_id, username, role)
      VALUES ('alice', 'jf-a', 'A', 'admin'), ('bob', 'jf-b', 'B', 'standard');
    INSERT INTO sessions (id, user_id, jellyfin_access_token, expires_at)
      VALUES ('s-a', 'alice', 'token-a', '2999-01-01'), ('s-b', 'bob', 'token-b', '2999-01-01');
    INSERT INTO media_items (id, media_type, tmdb_id, title, seerr_request_id)
      VALUES ('title', 'series', 23, 'Title', 11);
    INSERT INTO my_list (id, user_id, media_id, user_intent)
      VALUES ('l-a', 'alice', 'title', 'saved'), ('l-b', 'bob', 'title', 'not_saved');
    INSERT INTO user_preferences (user_id, auto_watchlist_requests) VALUES ('alice', 0);
  `);
  let reply: (req: http.IncomingMessage) => [number, unknown] = () => [404, null];
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req);
    const [code, data] = reply(req);
    res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const url = 'http://127.0.0.1:' + addr.port;
  const config = loadConfig({ SEERR_URL: url, SEERR_API_KEY: 'key', JELLYFIN_URL: url });
  const rows = () => db.prepare('SELECT * FROM my_list ORDER BY id').all() as Record<string, unknown>[];
  const pass = async (source: SyncSource, cursor = '', mayAdmit = () => true) => {
    await reconcilePass(db, config, source, cursor, {
      signal: new AbortController().signal, mayAdmit, advance: next => { cursor = next; },
    });
    return cursor;
  };
  return { db, path, rows, requests, pass, reply: (handler: typeof reply) => { reply = handler; } };
}

test('Seerr reconciles confirmed linked and fallback states without changing intent', async t => {
  const f = await fixture(t);

  const linked = (status: number, mediaStatus: number, is4k: unknown = false, type = 'tv') =>
    ({ id: 11, status, is4k, media: { tmdbId: 23, mediaType: type, status: is4k ? 1 : mediaStatus, status4k: mediaStatus } });
  const state = () => f.rows().map(row => row.acquisition_state);
  const expected = async (value: string) => {
    await f.pass('seerr');
    assert.deepEqual(state(), [value, value]);
  };
  const result = (data: unknown) => f.reply(() => [200, data]);
  result(linked(1, 2)); await expected('pending');
  result(linked(2, 3)); await expected('processing');
  result(linked(5, 4)); await expected('partially_available');
  result(linked(3, 1)); await expected('failed');
  result(linked(2, 3)); await expected('processing');
  result(linked(4, 3)); await expected('failed');
  result(linked(1, 5, true)); await expected('available');
  f.db.exec("UPDATE my_list SET updated_at = 'old'");
  await expected('available');
  assert.deepEqual(f.rows().map(row => row.updated_at), ['old', 'old']);
  result(linked(5, 7, false, 'movie')); await expected('available');
  result(linked(5, 7, null)); await expected('available');
  result(linked(5, 7)); await expected('not_requested');

  const fallback = (mediaInfo: unknown) => f.reply(req => req.url?.includes('/request/')
    ? [404, null] : [200, { id: 23, mediaInfo }]);
  fallback({ tmdbId: 23, status: 2, status4k: 5 }); await expected('available');
  for (const info of [undefined, null, { tmdbId: 23, status: 1, status4k: 1 },
    { tmdbId: 23, status: 7 }, { tmdbId: 23, status: 7, status4k: 6 },
    { tmdbId: 23, status: 1, status4k: '7' }]) {
    fallback(info); await expected('available');
  }
  fallback({ tmdbId: 23, status: 1, status4k: 7 }); await expected('not_requested');
  f.reply(() => {
    f.db.exec('UPDATE media_items SET seerr_request_id = 12');
    return [200, linked(5, 5)];
  });
  await expected('not_requested');
  assert.deepEqual(f.rows().map(row => row.user_intent), ['saved', 'not_saved']);
  assert.deepEqual(f.db.prepare('SELECT auto_watchlist_requests FROM user_preferences').get(), { auto_watchlist_requests: 0 });
});

test('Jellyfin corroborates identity and applies user-scoped playback and resets', async t => {
  const f = await fixture(t);
  const item = (played = false, position = 30) => ({
    Id: dashed, Type: 'Series', ProviderIds: { Tmdb: '23' }, RunTimeTicks: 100,
    UserData: { Played: played, PlaybackPositionTicks: position, LastPlayedDate: '2026-06-01T20:00:00+02:00' },
  });
  const reply = (items: unknown[], total = items.length) => f.reply(() => [200, { Items: items, TotalRecordCount: total }]);
  const mappedId = () => f.db.prepare("SELECT jellyfin_item_id AS id FROM media_items WHERE id = 'title'").get();
  reply([]); await f.pass('jellyfin');
  reply([item()], 26); await f.pass('jellyfin');
  reply([item(), item()]); await f.pass('jellyfin');
  assert.deepEqual(mappedId(), { id: null });
  f.reply(req => {
    const query = new URL(req.url!, 'http://upstream.invalid').searchParams;
    const alice = query.get('userId') === 'jf-a';
    assert.equal(req.headers['x-emby-token'], alice ? 'token-a' : 'token-b');
    assert.equal(query.get('enableUserData'), 'true');
    return [200, { TotalRecordCount: 1, Items: [item(!alice, alice ? 30 : 1)] }];
  });
  await f.pass('jellyfin');
  assert.deepEqual(mappedId(), { id: guid });
  await f.pass('jellyfin');
  assert.deepEqual(f.rows().map(row => [row.playback_state, row.playback_percentage,
    row.playback_runtime_ticks, row.last_played_at]), [
    ['in_progress', 30, 100, '2026-06-01T18:00:00.000Z'], ['watched', 100, 100, '2026-06-01T18:00:00.000Z'],
  ]);
  assert.ok(f.requests.some(req => req.url?.includes('ids=' + guid)));

  f.db.exec(`UPDATE media_items SET jellyfin_item_id = '${dashed}', tvdb_id = 17, imdb_id = 'tt123';
    UPDATE my_list SET updated_at = 'old';`);
  reply([{ ...item(), ProviderIds: { Tvdb: '17', Imdb: 'tt123' } }]); await f.pass('jellyfin');
  reply([{ ...item(), ProviderIds: { Tmdb: '23', Tvdb: '18' } }]); await f.pass('jellyfin');
  reply([{ ...item(), UserData: undefined }]); await f.pass('jellyfin');
  reply([{ ...item(), UserData: { Played: false, PlaybackPositionTicks: -1 } }]); await f.pass('jellyfin');
  reply([{ ...item(), UserData: { ...item().UserData, LastPlayedDate: 'not-a-date' } }]); await f.pass('jellyfin');
  reply([{ ...item(), UserData: { ...item().UserData, LastPlayedDate: '2026-02-30T00:00:00Z' } }]); await f.pass('jellyfin');
  assert.deepEqual(f.rows().map(row => row.updated_at), ['old', 'old']);

  const reset = { ...item(false, 0), RunTimeTicks: null, UserData: { Played: false, PlaybackPositionTicks: 0 } };
  f.db.exec(`INSERT INTO media_items (id, media_type, title, jellyfin_item_id)
    VALUES ('alias','movie','Alias','${guid}')`);
  reply([reset]); await f.pass('jellyfin');
  assert.deepEqual(f.rows().map(row => row.updated_at), ['old', 'old']);
  f.db.exec("DELETE FROM media_items WHERE id = 'alias'");
  f.reply(req => req.headers['x-emby-token'] === 'token-a'
    ? [401, null] : [200, { Items: [reset] }]);
  await f.pass('jellyfin');
  assert.deepEqual(f.rows().map(row => [row.playback_state, row.playback_runtime_ticks, row.last_played_at]), [
    ['in_progress', 100, '2026-06-01T18:00:00.000Z'], ['unwatched', null, null],
  ]);
  for (const change of [
    "UPDATE users SET role='standard' WHERE id='alice'",
    "UPDATE sessions SET expires_at='2000-01-01' WHERE id='s-a'",
    "DELETE FROM sessions WHERE id='s-a'",
  ]) {
    f.db.exec(`UPDATE users SET role='admin' WHERE id='alice';
      INSERT OR REPLACE INTO sessions (id, user_id, jellyfin_access_token, expires_at)
      VALUES ('s-a','alice','token-a','2999-01-01');`);
    f.reply(req => {
      if (req.headers['x-emby-token'] === 'token-a') f.db.exec(change);
      return [200, { Items: [reset] }];
    });
    await f.pass('jellyfin');
    assert.equal(f.rows()[0].playback_state, 'in_progress');
  }
  assert.deepEqual(mappedId(), { id: dashed });
});

test('contended sync write is bounded and retry preserves the foreground busy timeout', async t => {
  const f = await fixture(t);
  const other = createDb(f.path);
  t.after(() => { if (other.open) other.close(); });
  let deadline = Infinity;
  f.reply(() => {
    deadline = performance.now() + 30;
    return [200, { id: 11, status: 5, is4k: false, media: { tmdbId: 23, mediaType: 'tv', status: 5 } }];
  });
  other.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  try {
    await f.pass('seerr', '', () => performance.now() < deadline);
    assert.notEqual(deadline, Infinity);
    assert.ok(performance.now() - started < 1000);
    assert.deepEqual(f.rows().map(row => row.acquisition_state), ['not_requested', 'not_requested']);
    assert.equal(f.db.pragma('busy_timeout', { simple: true }), 5000);
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }
  await f.pass('seerr');
  assert.deepEqual(f.rows().map(row => row.acquisition_state), ['available', 'available']);
});

test('cursor advances only past attempted work and wraps after the tail', async t => {
  const f = await fixture(t);

  for (let index = 0; index < 22; index++) {
    const id = 'a' + String(index).padStart(2, '0');
    f.db.prepare("INSERT INTO media_items (id, media_type, tmdb_id, title) VALUES (?, 'movie', ?, ?)").run(id, 100 + index, id);
    f.db.prepare("INSERT INTO my_list (id, user_id, media_id) VALUES (?, 'alice', ?)").run(id, id);
  }
  let admissions = 0;
  const cursor = await f.pass('seerr', '', () => ++admissions <= 3);
  assert.equal(cursor, 'a00');
  assert.equal(f.requests.length, 1);
  assert.equal(await f.pass('seerr', cursor), 'a20');
  assert.equal(f.requests.length, 21);
  assert.equal(await f.pass('seerr', 'a20'), '');
  assert.equal(f.requests.length, 24); // The linked title also attempts its title-detail fallback.
});

test('Jellyfin retains the first candidate when its deadline expires before admission', async t => {
  const f = await fixture(t);
  for (const id of [null, dashed]) {
    f.db.prepare("UPDATE media_items SET jellyfin_item_id = ? WHERE id = 'title'").run(id);
    let admissions = 0;
    const before = f.rows();
    const calls = f.requests.length;
    const cursor = await f.pass('jellyfin', '', () => ++admissions <= 2);
    assert.equal(cursor, '');
    assert.equal(f.requests.length, calls);
    assert.deepEqual(f.rows(), before);
    await f.pass('jellyfin', cursor);
    const users = f.requests.slice(calls).map(req => new URLSearchParams(req.url!.split('?')[1]).get('userId'));
    assert.deepEqual(users, ['jf-a', 'jf-b']);
  }
});

async function discoveryFixture(t: TestContext) {
  const f = await fixture(t);
  f.db.exec(`
    UPDATE my_list SET playback_state = 'in_progress', playback_position_ticks = 12,
      playback_runtime_ticks = 100, playback_percentage = 12,
      last_played_at = '2026-06-01T00:00:00.000Z', updated_at = 'old'
  `);
  const match = {
    Id: dashed, Type: 'Series', ProviderIds: { Tmdb: '23' }, RunTimeTicks: 200,
    UserData: { Played: true, PlaybackPositionTicks: 56 },
  };
  const unrelated = { Id: '9'.repeat(32), Type: 'Series', ProviderIds: { Tmdb: '24' } };
  const originalMedia = f.db.prepare('SELECT * FROM media_items').all();
  const originalRows = f.rows();
  const preservesState = async (items: unknown[]) => {
    f.reply(() => [200, { Items: items, TotalRecordCount: items.length }]);
    await f.pass('jellyfin');
    assert.deepEqual(f.db.prepare('SELECT * FROM media_items').all(), originalMedia);
    assert.deepEqual(f.rows(), originalRows);
  };
  return { ...f, match, unrelated, preservesState };
}

test('Jellyfin discovery rejects a malformed TMDb ID on an otherwise unrelated result', async t => {
  const { match, unrelated, preservesState } = await discoveryFixture(t);
  await preservesState([match, { ...unrelated, ProviderIds: { Tmdb: { id: 24 } } }]);
});

test('Jellyfin discovery rejects duplicate normalized GUIDs before filtering identities', async t => {
  const { match, unrelated, preservesState } = await discoveryFixture(t);
  await preservesState([match, { ...unrelated, Id: guid }]);
  await preservesState([{ ...unrelated, Id: guid.toUpperCase() }, match]);
  const otherGuid = '1234567890abcdef1234567890abcdef';
  await preservesState([match,
    { ...unrelated, Id: otherGuid },
    { ...unrelated, Id: '12345678-90AB-CDEF-1234-567890ABCDEF', ProviderIds: { Tmdb: '25' } },
  ]);
});

test('Jellyfin leaves mapping and playback intact when discovery contains malformed entries', async t => {
  const f = await discoveryFixture(t);
  const { match, unrelated, preservesState } = f;
  const invalidProviders = [
    null, [],
    { Tmdb: 0 }, { Tmdb: '24x' }, { Tmdb: 9007199254740992 }, { Tmdb: null },
    { Tmdb: '24', Tvdb: -1 }, { Tmdb: '24', Tvdb: true },
    { Tmdb: '24', Imdb: 'bad' }, { Tmdb: '24', Imdb: 123 },
  ];
  for (const invalid of [null, [], 'invalid', {}, { ...unrelated, Id: 'invalid' },
    { ...unrelated, Type: null }, { ...unrelated, Type: 'Episode' },
    ...invalidProviders.map(ProviderIds => ({ ...unrelated, ProviderIds }))]) {
    await preservesState([match, invalid]);
  }
  await preservesState([{ ...match, ProviderIds: { Tvdb: '23' } }]);
  await preservesState([{ ...match, Type: 'Movie' }]);
  await preservesState([match, { ...match, Id: unrelated.Id }]);
  f.reply(() => [200, { Items: [match, unrelated], TotalRecordCount: 2 }]);
  await f.pass('jellyfin');
  assert.deepEqual(f.db.prepare('SELECT jellyfin_item_id AS id FROM media_items').get(), { id: guid });
  assert.equal(f.rows()[0].playback_state, 'watched');
});
