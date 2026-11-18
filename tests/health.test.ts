import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '../src/db/connection.js';
import { computeHealth, handleHealthRequest } from '../src/health/router.js';
import type { AppConfig } from '../src/config.js';

describe('Health Endpoint & Preflight Probing', () => {
  const activeServers: http.Server[] = [];
  const testDir = join(process.cwd(), 'tmp-test-health');

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    while (activeServers.length > 0) {
      const s = activeServers.pop();
      if (s) {
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('reports unconfigured status when upstream URLs are omitted', async () => {
    const dbPath = join(testDir, 'health1.db');
    const db = createDb(dbPath);
    try {
      const config: AppConfig = {
        port: 3000,
        databasePath: dbPath,
        sessionSecret: 'test_secret_key_at_least_32_characters_long_12345',
        sessionTtlDays: 7,
      };

      const { statusCode, payload } = await computeHealth(db, config);

      assert.strictEqual(statusCode, 200);
      assert.strictEqual(payload.status, 'ok');
      assert.strictEqual(payload.database.status, 'connected');
      assert.strictEqual(payload.database.wal, true);
      assert.strictEqual(payload.services.jellyfin.status, 'unconfigured');
      assert.strictEqual(payload.services.seerr.status, 'unconfigured');
    } finally {
      db.close();
    }
  });

  it('returns HTTP 503 when the database connection fails', async () => {
    const dbPath = join(testDir, 'broken.db');
    const db = createDb(dbPath);
    db.close(); // simulate broken connection

    const config: AppConfig = {
      port: 3000,
      databasePath: dbPath,
      sessionSecret: 'test_secret_key_at_least_32_characters_long_12345',
      sessionTtlDays: 7,
    };

    const { statusCode, payload } = await computeHealth(db, config);

    assert.strictEqual(statusCode, 503);
    assert.strictEqual(payload.status, 'unhealthy');
    assert.strictEqual(payload.database.status, 'disconnected');
  });

  it('handles reachable upstreams properly', async () => {
    // Mock Jellyfin server
    const jellyfinServer = http.createServer((req, res) => {
      if (req.url === '/System/Info/Public') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Version: '10.9.11' }));
      } else {
        res.writeHead(404).end();
      }
    });

    // Mock Seerr server
    const seerrServer = http.createServer((req, res) => {
      if (req.url === '/api/v1/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '1.33.2' }));
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((r) => jellyfinServer.listen(0, '127.0.0.1', () => r()));
    await new Promise<void>((r) => seerrServer.listen(0, '127.0.0.1', () => r()));
    activeServers.push(jellyfinServer, seerrServer);

    const jfPort = (jellyfinServer.address() as { port: number }).port;
    const seerrPort = (seerrServer.address() as { port: number }).port;

    const dbPath = join(testDir, 'upstreams.db');
    const db = createDb(dbPath);
    try {
      const config: AppConfig = {
        port: 3000,
        databasePath: dbPath,
        jellyfinUrl: `http://127.0.0.1:${jfPort}`,
        seerrUrl: `http://127.0.0.1:${seerrPort}`,
        seerrApiKey: 'test-api-key',
        sessionSecret: 'test_secret_key_at_least_32_characters_long_12345',
        sessionTtlDays: 7,
      };

      const { statusCode, payload } = await computeHealth(db, config);

      assert.strictEqual(statusCode, 200);
      assert.strictEqual(payload.status, 'ok');
      assert.strictEqual(payload.services.jellyfin.status, 'reachable');
      assert.strictEqual(payload.services.jellyfin.version, '10.9.11');
      assert.strictEqual(payload.services.seerr.status, 'reachable');
      assert.strictEqual(payload.services.seerr.version, '1.33.2');
    } finally {
      db.close();
    }
  });

  it('handles unreachable/failing upstreams gracefully without HTTP 503 and without leaking secrets', async () => {
    const SECRET_KEY = 'SUPER_SECRET_KEY_NEVER_LEAK_12345';

    // Server that returns error
    const brokenServer = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Unauthorized' }));
    });
    await new Promise<void>((r) => brokenServer.listen(0, '127.0.0.1', () => r()));
    activeServers.push(brokenServer);

    const brokenPort = (brokenServer.address() as { port: number }).port;

    const dbPath = join(testDir, 'secret.db');
    const db = createDb(dbPath);
    try {
      const config: AppConfig = {
        port: 3000,
        databasePath: dbPath,
        jellyfinUrl: 'http://127.0.0.1:1', // Connection refused
        seerrUrl: `http://127.0.0.1:${brokenPort}`, // 401 Unauthorized
        seerrApiKey: SECRET_KEY,
        sessionSecret: 'test_secret_key_at_least_32_characters_long_12345',
        sessionTtlDays: 7,
      };

      const { statusCode, payload } = await computeHealth(db, config);

      // Must remain 200 OK because database is healthy
      assert.strictEqual(statusCode, 200);
      assert.strictEqual(payload.status, 'degraded');

      assert.strictEqual(payload.services.jellyfin.status, 'unreachable');
      assert.ok(payload.services.jellyfin.error);

      assert.strictEqual(payload.services.seerr.status, 'unreachable');
      assert.strictEqual(payload.services.seerr.error, 'HTTP 401 Unauthorized');

      // CRITICAL: Ensure secret key is NEVER present in the serialized JSON response
      const serialized = JSON.stringify(payload);
      assert.strictEqual(serialized.includes(SECRET_KEY), false);
    } finally {
      db.close();
    }
  });

  it('handleHealthRequest serves HTTP 200 over actual HTTP server', async () => {
    const dbPath = join(testDir, 'http.db');
    const db = createDb(dbPath);
    try {
      const config: AppConfig = {
        port: 3000,
        databasePath: dbPath,
        sessionSecret: 'test_secret_key_at_least_32_characters_long_12345',
        sessionTtlDays: 7,
      };

      const server = http.createServer(async (req, res) => {
        const handled = await handleHealthRequest(req, res, db, config);
        if (!handled) {
          res.writeHead(404).end();
        }
      });

      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      activeServers.push(server);

      const serverPort = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${serverPort}/health`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'application/json');

      const data = (await res.json()) as { status: string; database: { wal: boolean } };
      assert.strictEqual(data.status, 'ok');
      assert.strictEqual(data.database.wal, true);
    } finally {
      db.close();
    }
  });
});
