import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';

describe('Transactional Migrations', () => {
  const testDir = join(process.cwd(), 'tmp-test-migrations');
  const migrationsDir = join(testDir, 'migrations');
  const dbPath = join(testDir, 'test.db');

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(migrationsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('applies 0001_init.sql cleanly and creates system_metadata with version 1', () => {
    const db = createDb(dbPath);
    try {
      // Use the actual repo's 0001_init.sql content
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

      const result = runMigrations(db, migrationsDir);
      assert.strictEqual(result.applied.length, 1);
      assert.strictEqual(result.applied[0], '0001_init.sql');

      const metadataRow = db
        .prepare('SELECT value FROM system_metadata WHERE key = ?')
        .get('schema_version') as { value: string };
      assert.strictEqual(metadataRow.value, '1');

      const migrationRow = db
        .prepare('SELECT name FROM _migrations WHERE name = ?')
        .get('0001_init.sql') as { name: string };
      assert.strictEqual(migrationRow.name, '0001_init.sql');
    } finally {
      db.close();
    }
  });

  it('is idempotent on subsequent runs', () => {
    const db = createDb(dbPath);
    try {
      writeFileSync(
        join(migrationsDir, '0001_init.sql'),
        `CREATE TABLE IF NOT EXISTS system_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`
      );

      const firstRun = runMigrations(db, migrationsDir);
      assert.strictEqual(firstRun.applied.length, 1);

      const secondRun = runMigrations(db, migrationsDir);
      assert.strictEqual(secondRun.applied.length, 0);
      assert.strictEqual(secondRun.totalApplied, 1);
    } finally {
      db.close();
    }
  });

  it('adversarial rollback test: syntax/constraint error rolls back transaction completely', () => {
    const db = createDb(dbPath);
    try {
      // Migration 1: valid
      writeFileSync(
        join(migrationsDir, '0001_init.sql'),
        `CREATE TABLE test_table (id INTEGER PRIMARY KEY, title TEXT NOT NULL);`
      );
      runMigrations(db, migrationsDir);

      // Migration 2: contains a valid statement followed by a fatal error
      writeFileSync(
        join(migrationsDir, '0002_faulty.sql'),
        `
        INSERT INTO test_table (title) VALUES ('Should be rolled back');
        -- This statement is intentionally invalid SQL syntax
        INVALID SQL SYNTAX HERE FAIL IMMEDIATELY;
        `
      );

      assert.throws(
        () => {
          runMigrations(db, migrationsDir);
        },
        (err: Error) => {
          return err.message.includes('Migration "0002_faulty.sql" failed');
        }
      );

      // Verify transaction rollback: table should have 0 rows
      const count = db.prepare('SELECT COUNT(*) as count FROM test_table').get() as {
        count: number;
      };
      assert.strictEqual(count.count, 0);

      // Verify migration record was NOT committed
      const recorded = db
        .prepare('SELECT name FROM _migrations WHERE name = ?')
        .get('0002_faulty.sql');
      assert.strictEqual(recorded, undefined);
    } finally {
      db.close();
    }
  });

  it('out-of-order rejection test: unapplied migration sorting before applied migration throws', () => {
    const db = createDb(dbPath);
    try {
      // Apply 0002 first
      writeFileSync(
        join(migrationsDir, '0002_user.sql'),
        `CREATE TABLE users (id INTEGER PRIMARY KEY);`
      );
      runMigrations(db, migrationsDir);

      // Now add 0001_init.sql which sorts before 0002_user.sql
      writeFileSync(
        join(migrationsDir, '0001_init.sql'),
        `CREATE TABLE init_table (id INTEGER PRIMARY KEY);`
      );

      assert.throws(
        () => {
          runMigrations(db, migrationsDir);
        },
        (err: Error) => {
          return err.message.includes('Out-of-order migration detected');
        }
      );
    } finally {
      db.close();
    }
  });
});
