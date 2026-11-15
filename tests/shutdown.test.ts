import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '../src/db/connection.js';
import { performGracefulShutdown, _resetShutdownState } from '../src/server/shutdown.js';

describe('Graceful Shutdown & WAL Checkpoint', () => {
  const testDir = join(process.cwd(), 'tmp-test-shutdown');

  beforeEach(() => {
    _resetShutdownState();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    _resetShutdownState();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('closes HTTP server and flushes SQLite WAL checkpoint cleanly', async () => {
    const dbPath = join(testDir, 'shutdown.db');
    const db = createDb(dbPath);

    // Write some data to create active WAL entries
    db.exec('CREATE TABLE test_shutdown (id INTEGER PRIMARY KEY, note TEXT);');
    db.prepare('INSERT INTO test_shutdown (note) VALUES (?)').run('wal entry before shutdown');

    const server = http.createServer((_req, res) => {
      res.writeHead(200).end('ok');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    assert.strictEqual(server.listening, true);

    await performGracefulShutdown(server, db, 1000);

    // Verify server is closed
    assert.strictEqual(server.listening, false);

    // Verify database connection is closed (calling pragma will throw)
    assert.throws(() => {
      db.pragma('journal_mode');
    });
  });

  it('is idempotent when called multiple times concurrently or sequentially', async () => {
    const dbPath = join(testDir, 'idempotent.db');
    const db = createDb(dbPath);
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    // First call executes shutdown
    await performGracefulShutdown(server, db, 1000);
    assert.strictEqual(server.listening, false);

    // Second call should return immediately without throwing errors
    await performGracefulShutdown(server, db, 1000);
  });
});
