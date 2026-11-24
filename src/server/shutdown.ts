import type { Server } from 'node:http';
import type Database from 'better-sqlite3';

let shutdowns = new WeakMap<Server, Promise<void>>();

export function _resetShutdownState(): void {
  shutdowns = new WeakMap();
}

export function performGracefulShutdown(
  server: Server,
  db: Database.Database,
  timeoutMs: number = 5000,
  stopWorker: () => Promise<void> = async () => {}
): Promise<void> {
  const existing = shutdowns.get(server);
  if (existing) return existing;
  const shutdown = drain(server, db, timeoutMs, stopWorker);
  shutdowns.set(server, shutdown);
  return shutdown;
}

async function drain(
  server: Server, db: Database.Database, timeoutMs: number, stopWorker: () => Promise<void>
): Promise<void> {
  console.log('Initiating graceful shutdown...');
  const workerStopped = stopWorker();

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

  await workerStopped;

  // 2. Checkpoint WAL and close SQLite database cleanly
  try {
    console.log('Flushing SQLite WAL checkpoint (TRUNCATE)...');
    db.pragma('busy_timeout = 0');
    const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
    if (checkpoint?.busy) console.warn('WAL checkpoint deferred due to SQLite contention.');
    else console.log('WAL checkpoint flushed.');
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
  timeoutMs: number = 5000,
  stopWorker?: () => Promise<void>
): void {
  const shutdown = async (signal: string) => {
    console.log(`Received signal ${signal}.`);
    try {
      await performGracefulShutdown(server, db, timeoutMs, stopWorker);
      process.exit(0);
    } catch (err) {
      console.error('Fatal error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
