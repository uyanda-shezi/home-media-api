import type { Server } from 'node:http';
import type Database from 'better-sqlite3';

let isShuttingDown = false;

export function _resetShutdownState(): void {
  isShuttingDown = false;
}

export async function performGracefulShutdown(
  server: Server,
  db: Database.Database,
  timeoutMs: number = 5000
): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.log('Initiating graceful shutdown...');

  // 1. Close HTTP server and wait for in-flight requests to drain
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.warn('Shutdown timeout reached; forcing socket closure.');
      server.closeAllConnections?.();
      resolve();
    }, timeoutMs);

    server.close((err) => {
      clearTimeout(timer);
      if (err) {
        console.error('Error closing HTTP server:', err);
      } else {
        console.log('HTTP server closed successfully.');
      }
      resolve();
    });

    // Close idle connections immediately to speed up drain
    server.closeIdleConnections?.();
  });

  // 2. Checkpoint WAL and close SQLite database cleanly
  try {
    console.log('Flushing SQLite WAL checkpoint (TRUNCATE)...');
    db.pragma('wal_checkpoint(TRUNCATE)');
    console.log('WAL checkpoint flushed.');
  } catch (err) {
    console.error('Error during WAL checkpoint:', err);
  }

  try {
    db.close();
    console.log('Database connection closed.');
  } catch (err) {
    console.error('Error closing database:', err);
  }
}

export function registerShutdownHandlers(
  server: Server,
  db: Database.Database,
  timeoutMs: number = 5000
): void {
  const shutdown = async (signal: string) => {
    console.log(`Received signal ${signal}.`);
    try {
      await performGracefulShutdown(server, db, timeoutMs);
      process.exit(0);
    } catch (err) {
      console.error('Fatal error during shutdown:', err);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
