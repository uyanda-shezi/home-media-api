import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface DbHealthResult {
  ok: boolean;
  wal: boolean;
  error?: string;
}

export function createDb(
  databasePath: string = './data/home-media.db',
  options: Database.Options = {}
): Database.Database {
  if (databasePath !== ':memory:') {
    const absolutePath = resolve(databasePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
  }

  const db = new Database(databasePath, options);

  // Apply required pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  return db;
}

export function checkDbHealth(db: Database.Database): DbHealthResult {
  try {
    const selectResult = db.prepare('SELECT 1 as alive').get() as { alive: number } | undefined;
    if (!selectResult || selectResult.alive !== 1) {
      return { ok: false, wal: false, error: 'Database ping returned invalid result' };
    }

    const journalModeResult = db.pragma('journal_mode', { simple: true }) as string;
    const isWal = typeof journalModeResult === 'string' && journalModeResult.toLowerCase() === 'wal';

    return { ok: true, wal: isWal };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, wal: false, error: errorMsg };
  }
}
