import Database from 'better-sqlite3';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDb } from '../db/connection.js';
import { loadConfig } from '../config.js';

export async function performBackup(
  db: Database.Database,
  backupsDir: string = './backups'
): Promise<string> {
  const absoluteBackupsDir = resolve(backupsDir);
  await mkdir(absoluteBackupsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalFilename = `home-media-${timestamp}.db`;
  const finalPath = join(absoluteBackupsDir, finalFilename);
  const tempPath = `${finalPath}.tmp`;

  try {
    await db.backup(tempPath);
    await rename(tempPath, finalPath);
    return finalPath;
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup error if temp file does not exist
    }
    throw new Error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// CLI execution
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const db = createDb(config.databasePath, { readonly: true });
    const backupPath = await performBackup(db, './backups');
    console.log(`Backup completed successfully: ${backupPath}`);
    db.close();
    process.exit(0);
  } catch (error) {
    console.error('Backup error:', error);
    process.exit(1);
  }
}
