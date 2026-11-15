import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { performBackup } from '../scripts/backup.js';
import { verifyBackup, findLatestBackup } from '../scripts/verify-backup.js';

describe('Atomic Backup & Restore Verification', () => {
  const testDir = join(process.cwd(), 'tmp-test-backup');
  const backupsDir = join(testDir, 'backups');
  const migrationsDir = join(testDir, 'migrations');
  const dbPath = join(testDir, 'primary.db');

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(backupsDir, { recursive: true });
    mkdirSync(migrationsDir, { recursive: true });

    writeFileSync(
      join(migrationsDir, '0001_init.sql'),
      `
      CREATE TABLE IF NOT EXISTS system_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO system_metadata (key, value) VALUES ('schema_version', '1');
      `
    );
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('produces a snapshot to backups directory and verifies clean integrity', async () => {
    const db = createDb(dbPath);
    try {
      runMigrations(db, migrationsDir);

      const backupPath = await performBackup(db, backupsDir);
      assert.strictEqual(existsSync(backupPath), true);
      assert.strictEqual(backupPath.endsWith('.db'), true);
      // Temp file should not remain
      assert.strictEqual(existsSync(`${backupPath}.tmp`), false);

      const verification = verifyBackup(backupPath);
      assert.strictEqual(verification.ok, true);
      assert.strictEqual(verification.error, undefined);
    } finally {
      db.close();
    }
  });

  it('finds latest backup correctly', async () => {
    const db = createDb(dbPath);
    try {
      runMigrations(db, migrationsDir);

      const backup1 = await performBackup(db, backupsDir);
      // slight delay to guarantee different mtime
      await new Promise((r) => setTimeout(r, 100));
      const backup2 = await performBackup(db, backupsDir);

      const latest = findLatestBackup(backupsDir);
      assert.strictEqual(latest, backup2);
    } finally {
      db.close();
    }
  });

  it('verifies concurrency: backup succeeds while active reads and writes occur', async () => {
    const db = createDb(dbPath);
    try {
      runMigrations(db, migrationsDir);
      db.exec('CREATE TABLE test_concurrent (id INTEGER PRIMARY KEY, msg TEXT);');

      // Start concurrent writes in background loop
      let continueWriting = true;
      let writeCount = 0;

      const writerPromise = (async () => {
        while (continueWriting) {
          db.prepare('INSERT INTO test_concurrent (msg) VALUES (?)').run(`msg-${writeCount++}`);
          await new Promise((r) => setTimeout(r, 2));
        }
      })();

      // Run backup while writes are actively taking place
      const backupPath = await performBackup(db, backupsDir);

      // Stop writes
      continueWriting = false;
      await writerPromise;

      assert.ok(writeCount > 0);
      assert.strictEqual(existsSync(backupPath), true);

      // Verify backup is uncorrupted and readable
      const verification = verifyBackup(backupPath, ['_migrations', 'system_metadata', 'test_concurrent']);
      assert.strictEqual(verification.ok, true);
    } finally {
      db.close();
    }
  });

  it('corruption detection: zero-byte and corrupt SQLite files fail verification', () => {
    const zeroByteFile = join(testDir, 'zero-byte.db');
    writeFileSync(zeroByteFile, Buffer.alloc(0));

    const zeroResult = verifyBackup(zeroByteFile);
    assert.strictEqual(zeroResult.ok, false);
    assert.ok(zeroResult.error);

    const corruptFile = join(testDir, 'corrupt.db');
    writeFileSync(corruptFile, Buffer.from('NOT A SQLITE FILE HEADER GARBAGE DATA'));

    const corruptResult = verifyBackup(corruptFile);
    assert.strictEqual(corruptResult.ok, false);
    assert.ok(corruptResult.error);
  });
});
