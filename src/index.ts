import http from 'node:http';
import { loadConfig } from './config.js';
import { createDb } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { checkServicesPreflight } from './health/preflight.js';
import { handleHealthRequest } from './health/router.js';
import { registerShutdownHandlers } from './server/shutdown.js';

export async function bootstrap() {
  const config = loadConfig();
  console.log('Starting Home Media API...');
  console.log(`Database path: ${config.databasePath}`);

  // 1. Initialize SQLite Database
  const db = createDb(config.databasePath);

  // 2. Run pending migrations
  try {
    const migrationResult = runMigrations(db, './migrations');
    if (migrationResult.applied.length > 0) {
      console.log(`Applied migrations: ${migrationResult.applied.join(', ')}`);
    } else {
      console.log('Database schema is up to date.');
    }
  } catch (err) {
    console.error('Fatal: Migration runner failed on startup:', err);
    db.close();
    process.exit(1);
  }

  // 3. Pre-flight check for external services (non-blocking / non-fatal)
  console.log('Running upstream pre-flight checks...');
  const services = await checkServicesPreflight(config);
  console.log(
    `Jellyfin status: ${services.jellyfin.status}${
      services.jellyfin.version ? ` (v${services.jellyfin.version})` : ''
    }${services.jellyfin.error ? ` [${services.jellyfin.error}]` : ''}`
  );
  console.log(
    `Seerr status: ${services.seerr.status}${
      services.seerr.version ? ` (v${services.seerr.version})` : ''
    }${services.seerr.error ? ` [${services.seerr.error}]` : ''}`
  );

  // 4. HTTP Server
  const server = http.createServer(async (req, res) => {
    try {
      const handled = await handleHealthRequest(req, res, db, config);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      }
    } catch (err) {
      console.error('Unhandled request error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  });

  registerShutdownHandlers(server, db);

  server.listen(config.port, () => {
    console.log(`Home Media API listening on port ${config.port}`);
  });

  return { server, db, config };
}

// Automatically start when run directly
if (process.argv[1] && process.argv[1].endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  bootstrap().catch((err) => {
    console.error('Failed to bootstrap application:', err);
    process.exit(1);
  });
}
