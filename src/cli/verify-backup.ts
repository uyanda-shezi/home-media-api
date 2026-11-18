import Database from 'better-sqlite3';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface VerifyResult {
  ok: boolean;
  path: string;
  error?: string;
}

export function findLatestBackup(backupsDir: string = './backups'): string | null {
  const absoluteBackupsDir = resolve(backupsDir);
  let files: string[] = [];
  try {
    files = readdirSync(absoluteBackupsDir);
  } catch {
    return null;
  }

  const dbFiles = files
    .filter((f) => f.endsWith('.db') && !f.endsWith('.tmp'))
    .map((f) => {
      const fullPath = join(absoluteBackupsDir, f);
      return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
    });

  if (dbFiles.length === 0) {
    return null;
  }

  dbFiles.sort((a, b) => b.mtime - a.mtime);
  return dbFiles[0].path;
}

export function verifyBackup(
  backupFilePath: string,
  requiredTables: string[] = ['_migrations', 'system_metadata']
): VerifyResult {
  let db: Database.Database | null = null;
  try {
    const resolvedPath = resolve(backupFilePath);
    db = new Database(resolvedPath, { readonly: true, fileMustExist: true });

    // 1. Run PRAGMA integrity_check
    const integrityResult = db.pragma('integrity_check', { simple: true }) as string;
    if (integrityResult !== 'ok') {
      return {
        ok: false,
        path: resolvedPath,
        error: `PRAGMA integrity_check failed: ${integrityResult}`,
      };
    }

    // 2. Run PRAGMA quick_check
    const quickResult = db.pragma('quick_check', { simple: true }) as string;
    if (quickResult !== 'ok') {
      return {
        ok: false,
        path: resolvedPath,
        error: `PRAGMA quick_check failed: ${quickResult}`,
      };
    }

    // 3. Verify required tables exist
    const rows = db
      .prepare('SELECT name FROM sqlite_master WHERE type = ?')
      .all('table') as { name: string }[];
    const existingTables = new Set(rows.map((r) => r.name));

    for (const table of requiredTables) {
      if (!existingTables.has(table)) {
        return {
          ok: false,
          path: resolvedPath,
          error: `Required table "${table}" is missing from backup`,
        };
      }
    }

    return { ok: true, path: resolvedPath };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      path: backupFilePath,
      error: `Verification error: ${errorMsg}`,
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close error
      }
    }
  }
}

// CLI execution
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targetPath = process.argv[2] || findLatestBackup('./backups');

  if (!targetPath) {
    console.error('Error: No backup file specified and no .db files found in ./backups');
    process.exit(1);
  }

  const result = verifyBackup(targetPath);
  if (result.ok) {
    console.log(`Backup verification PASSED for: ${result.path}`);
    process.exit(0);
  } else {
    console.error(`Backup verification FAILED for: ${result.path}`);
    console.error(`Reason: ${result.error}`);
    process.exit(1);
  }
}
