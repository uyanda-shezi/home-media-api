import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDb } from './connection.js';
import { loadConfig } from '../config.js';

const MIGRATION_FILE_PATTERN = /^\d{4}_[\w-]+\.sql$/;

export interface MigrationResult {
  applied: string[];
  totalApplied: number;
}

export function runMigrations(
  db: Database.Database,
  migrationsDir: string = './migrations'
): MigrationResult {
  const absoluteDir = resolve(migrationsDir);

  // 1. Ensure _migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 2. Fetch already applied migrations in insertion order
  const appliedRows = db.prepare('SELECT name FROM _migrations ORDER BY id ASC').all() as {
    name: string;
  }[];
  const appliedNames = new Set(appliedRows.map((r) => r.name));
  const latestApplied = appliedRows.length > 0 ? appliedRows[appliedRows.length - 1].name : null;

  // 3. Read migration files from migrations directory
  let dirEntries: string[] = [];
  try {
    dirEntries = readdirSync(absoluteDir);
  } catch (err) {
    throw new Error(`Failed to read migrations directory at ${absoluteDir}: ${err}`);
  }

  // Filter and validate migration file naming
  const migrationFiles: string[] = [];
  for (const entry of dirEntries) {
    if (entry.endsWith('.sql')) {
      if (!MIGRATION_FILE_PATTERN.test(entry)) {
        throw new Error(
          `Invalid migration filename format: "${entry}". Must match pattern ^\\d{4}_[\\w-]+\\.sql$`
        );
      }
      migrationFiles.push(entry);
    }
  }

  // Sort lexicographically
  migrationFiles.sort();

  // 4. Out-of-order & tampering validation
  if (latestApplied !== null) {
    for (const file of migrationFiles) {
      if (!appliedNames.has(file) && file <= latestApplied) {
        throw new Error(
          `Out-of-order migration detected: "${file}" cannot be applied because "${latestApplied}" has already been applied.`
        );
      }
    }
  }

  // 5. Apply pending migrations using BEGIN IMMEDIATE transaction
  const newlyApplied: string[] = [];
  const applyMigration = db.transaction((name: string, sqlContent: string) => {
    db.exec(sqlContent);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
  }).immediate;

  for (const file of migrationFiles) {
    if (!appliedNames.has(file)) {
      const filePath = join(absoluteDir, file);
      const sqlContent = readFileSync(filePath, 'utf-8');

      try {
        applyMigration(file, sqlContent);
        newlyApplied.push(file);
      } catch (err) {
        throw new Error(`Migration "${file}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    applied: newlyApplied,
    totalApplied: appliedRows.length + newlyApplied.length,
  };
}

// CLI runner entrypoint
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const db = createDb(config.databasePath);
    const result = runMigrations(db, './migrations');
    console.log(
      `Migrations complete. Newly applied: ${result.applied.length}. Total applied: ${result.totalApplied}.`
    );
    if (result.applied.length > 0) {
      console.log(`Applied files: ${result.applied.join(', ')}`);
    }
    db.close();
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}
