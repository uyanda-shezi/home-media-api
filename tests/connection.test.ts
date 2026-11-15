import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, checkDbHealth } from '../src/db/connection.js';

describe('SQLite Connection & Pragmas', () => {
  const testDir = join(process.cwd(), 'tmp-test-db');

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates directory if database directory is absent', () => {
    const dbPath = join(testDir, 'nested', 'test.db');
    assert.strictEqual(existsSync(join(testDir, 'nested')), false);

    const db = createDb(dbPath);
    try {
      assert.strictEqual(existsSync(join(testDir, 'nested')), true);
      assert.strictEqual(existsSync(dbPath), true);
    } finally {
      db.close();
    }
  });

  it('verifies PRAGMA journal_mode is WAL', () => {
    const dbPath = join(testDir, 'wal.db');
    const db = createDb(dbPath);
    try {
      const mode = db.pragma('journal_mode', { simple: true });
      assert.strictEqual(String(mode).toLowerCase(), 'wal');
    } finally {
      db.close();
    }
  });

  it('verifies PRAGMA foreign_keys is enabled (1)', () => {
    const db = createDb(':memory:');
    try {
      const fk = db.pragma('foreign_keys', { simple: true });
      assert.strictEqual(Number(fk), 1);
    } finally {
      db.close();
    }
  });

  it('verifies PRAGMA busy_timeout is 5000', () => {
    const db = createDb(':memory:');
    try {
      const timeout = db.pragma('busy_timeout', { simple: true });
      assert.strictEqual(Number(timeout), 5000);
    } finally {
      db.close();
    }
  });

  it('verifies PRAGMA synchronous is NORMAL (1)', () => {
    const db = createDb(':memory:');
    try {
      const sync = db.pragma('synchronous', { simple: true });
      assert.strictEqual(Number(sync), 1);
    } finally {
      db.close();
    }
  });

  it('verifies checkDbHealth reports ok on healthy connection', () => {
    const dbPath = join(testDir, 'health.db');
    const db = createDb(dbPath);
    try {
      const health = checkDbHealth(db);
      assert.strictEqual(health.ok, true);
      assert.strictEqual(health.wal, true);
    } finally {
      db.close();
    }
  });

  it('verifies checkDbHealth reports error when connection is closed', () => {
    const db = createDb(':memory:');
    db.close();
    const health = checkDbHealth(db);
    assert.strictEqual(health.ok, false);
    assert.strictEqual(health.wal, false);
    assert.ok(health.error);
  });
});
