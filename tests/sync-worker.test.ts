import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerShutdownHandlers } from '../src/server/shutdown.js';
import { setImmediate as turn } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { createSyncWorker } from '../src/sync/worker.js';
import { readSeerrSync, SeerrError } from '../src/seerr/client.js';

function database(path = ':memory:') {
  const db = createDb(path);
  runMigrations(db);
  db.exec(`
    INSERT INTO users (id, jellyfin_user_id, username, role) VALUES ('u','j','user','standard');
    INSERT INTO sessions (id, user_id, jellyfin_access_token, expires_at) VALUES ('s','u','private-token','2999-01-01');
    INSERT INTO media_items (id, media_type, tmdb_id, title) VALUES ('m','movie',1,'title');
    INSERT INTO my_list (id, user_id, media_id) VALUES ('l','u','m');
  `);
  return db;
}

test('sources progress independently and hints respect cadence, coalescing, gap and backoff', async t => {
  const db = database();
  const calls = { seerr: 0, jellyfin: 0 };
  let fail = true;
  let release: (() => void) | undefined;
  let hold = false;
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/Items')) {
      calls.jellyfin++;
      res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
    } else {
      calls.seerr++;
      const finish = () => {
        res.statusCode = fail ? 503 : 200;
        res.end(JSON.stringify({ id: 1, mediaInfo: { tmdbId: 1, status: 5 }, secret: 'private-key' }));
      };
      if (hold) release = finish;
      else finish();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = 'http://127.0.0.1:' + address.port;
  const config = loadConfig({ SEERR_URL: url, SEERR_API_KEY: 'private-key', JELLYFIN_URL: url,
    SYNC_WEBHOOK_SECRET: 'private-webhook-secret'.repeat(2) });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const logs: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args.join(' ')); });
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args.join(' ')); });
  const disabled = createSyncWorker(db, config, Date.now);
  t.mock.timers.tick(1000);
  assert.equal(disabled.available('seerr'), false);
  assert.equal(disabled.accept('jellyfin'), false);
  assert.deepEqual(calls, { seerr: 0, jellyfin: 0 });
  assert.deepEqual(db.prepare('SELECT acquisition_state FROM my_list').get(), { acquisition_state: 'not_requested' });
  await disabled.stop();
  const worker = createSyncWorker(db, { ...config, syncEnabled: true }, Date.now);
  t.after(async () => {
    await worker.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  });
  const until = async (done: () => boolean) => {
    const deadline = performance.now() + 3000;
    while (!done() && performance.now() < deadline) await turn();
    assert.ok(done(), 'expected sync outcome');
    await turn();
  };
  const outcomes = (word: string) => logs.filter(line => line.includes(word)).length;
  t.mock.timers.tick(1);
  await until(() => outcomes('seerr: backing off') === 1 && outcomes('jellyfin: completed') === 1);
  assert.equal(worker.accept('seerr'), true);
  assert.equal(worker.accept('seerr'), true);
  assert.equal(worker.accept('jellyfin'), true);
  t.mock.timers.tick(4999);
  await turn();
  assert.equal(calls.jellyfin, 1);
  t.mock.timers.tick(1);
  await until(() => outcomes('jellyfin: completed') === 2);
  assert.equal(calls.seerr, 1);
  t.mock.timers.tick(55_000);
  await until(() => outcomes('seerr: backing off') === 2);
  t.mock.timers.tick(60_000);
  await until(() => outcomes('jellyfin: completed') === 3);
  assert.equal(calls.seerr, 2);
  t.mock.timers.tick(60_000);
  await until(() => outcomes('seerr: backing off') === 3);
  for (const [delay, failures] of [[240_000, 4], [300_000, 5]]) {
    t.mock.timers.tick(delay - 1);
    await turn();
    assert.equal(calls.seerr, failures - 1);
    t.mock.timers.tick(1);
    await until(() => outcomes('seerr: backing off') === failures);
  }
  fail = false;
  t.mock.timers.tick(300_000);
  await until(() => outcomes('seerr: completed') === 1);
  assert.deepEqual(db.prepare('SELECT acquisition_state FROM my_list').get(), { acquisition_state: 'available' });
  hold = true;
  worker.accept('seerr');
  t.mock.timers.tick(5000);
  await until(() => release !== undefined);
  worker.accept('seerr');
  worker.accept('seerr');
  assert.equal(calls.seerr, 7);
  release!();
  hold = false;
  await until(() => outcomes('seerr: completed') === 2);
  t.mock.timers.tick(5000);
  await until(() => outcomes('seerr: completed') === 3);
  assert.equal(calls.seerr, 8);
  assert.ok(!logs.join(' ').includes('private-'));
});

test('sync transport rejects redirects and times out while consuming the response body', async t => {
  let redirected = false;
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith('/1')) {
      res.writeHead(302, { Location: '/redirect-target' }).end();
    } else if (req.url?.endsWith('/2')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
    } else {
      redirected = true;
      res.end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = 'http://127.0.0.1:' + address.port;
  const signal = new AbortController().signal;
  const upstreamFailure = (err: unknown) => err instanceof SeerrError && err.statusCode === 502;
  await assert.rejects(readSeerrSync(url, 'private-key', 'request', 1, signal), upstreamFailure);
  assert.equal(redirected, false);
  const start = performance.now();
  await assert.rejects(readSeerrSync(url, 'private-key', 'request', 2, signal), upstreamFailure);
  assert.ok(performance.now() - start >= 4500 && performance.now() - start < 7000);
});

test('repeated shutdown signals abort a pending upstream body and defer a contended checkpoint', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'home-media-sync-stop-'));
  const path = join(dir, 'db.sqlite');
  const db = database(path);
  const competing = createDb(path);
  competing.exec('BEGIN IMMEDIATE');
  const api = http.createServer();
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  let seen!: () => void;

  const requested = new Promise<void>(resolve => { seen = resolve; });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{');
    seen();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = loadConfig({ SYNC_ENABLED: 'true', SEERR_API_KEY: 'key', SEERR_URL: 'http://127.0.0.1:' + address.port });
  const worker = createSyncWorker(db, config);
  t.after(async () => {
    await worker.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (db.open) db.close();
    competing.close();
    if (api.listening) await new Promise<void>(resolve => api.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await requested;
  const exit = t.mock.method(process, 'exit', (code: number) => {
    assert.equal(code, 0);
    assert.equal(db.open, false);
  });
  const previous = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
  registerShutdownHandlers(api, db, 1000, async () => {
    const stop = worker.stop();
    assert.equal(worker.stop(), stop);
    assert.equal(worker.accept('seerr'), false);
    await stop;
    assert.equal(db.open, true);
    assert.deepEqual(db.prepare('SELECT acquisition_state FROM my_list').get(), { acquisition_state: 'not_requested' });
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const added = process.listeners(signal).find(listener => !previous[signal].includes(listener));
    assert.ok(added);
    t.after(() => process.removeListener(signal, added as () => void));
  }
  const start = performance.now();
  process.emit('SIGINT', 'SIGINT');
  process.emit('SIGTERM', 'SIGTERM');
  assert.equal(exit.mock.callCount(), 0);
  while (exit.mock.callCount() < 2 && performance.now() - start < 1000) await turn();
  assert.equal(exit.mock.callCount(), 2);
  assert.ok(exit.mock.calls.every(call => call.error === undefined));
  assert.equal(db.open, false);
});
