import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { checkDbHealth } from '../db/connection.js';
import { checkServicesPreflight, type ServicesHealth } from './preflight.js';

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'unhealthy';
  timestamp: string;
  database: {
    status: 'connected' | 'disconnected';
    wal: boolean;
  };
  services: ServicesHealth;
}

export async function computeHealth(
  db: Database.Database,
  config: AppConfig
): Promise<{ statusCode: number; payload: HealthResponse }> {
  const dbHealth = checkDbHealth(db);
  const servicesHealth = await checkServicesPreflight(config);

  const isDbHealthy = dbHealth.ok;
  const isUpstreamDegraded =
    servicesHealth.jellyfin.status === 'unreachable' ||
    servicesHealth.seerr.status === 'unreachable';

  let overallStatus: 'ok' | 'degraded' | 'unhealthy' = 'ok';
  let statusCode = 200;

  if (!isDbHealthy) {
    overallStatus = 'unhealthy';
    statusCode = 503;
  } else if (isUpstreamDegraded) {
    overallStatus = 'degraded';
    statusCode = 200;
  }

  const payload: HealthResponse = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    database: {
      status: isDbHealthy ? 'connected' : 'disconnected',
      wal: dbHealth.wal,
    },
    services: servicesHealth,
  };

  return { statusCode, payload };
}

export async function handleHealthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  config: AppConfig
): Promise<boolean> {
  const urlPath = req.url?.split('?')[0];

  if (req.method === 'GET' && (urlPath === '/health' || urlPath === '/health/')) {
    const { statusCode, payload } = await computeHealth(db, config);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload, null, 2));
    return true;
  }

  return false;
}
