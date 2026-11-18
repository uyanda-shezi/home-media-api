import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { verifyToken } from './crypto.js';
import {
  getSessionWithUser,
  type HouseholdRole,
  type SessionRecord,
  type UserRecord,
} from '../users/service.js';

export interface AuthenticatedContext {
  user: UserRecord;
  session: SessionRecord;
}

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

export function sendError(res: ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { error: message });
}

export async function readJsonBody<T = unknown>(
  req: IncomingMessage,
  maxBytes: number = 65536 // 64KB max request body limit
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  return new Promise((resolve) => {
    let body = '';
    let bytesRead = 0;
    let exceeded = false;

    req.on('data', (chunk: Buffer | string) => {
      if (exceeded) return;
      bytesRead += Buffer.byteLength(chunk);

      if (bytesRead > maxBytes) {
        exceeded = true;
        req.destroy();
        resolve({ ok: false, status: 413, error: 'Payload Too Large' });
        return;
      }

      body += chunk;
    });

    req.on('end', () => {
      if (exceeded) return;

      if (!body || body.trim().length === 0) {
        resolve({ ok: true, data: {} as T });
        return;
      }

      try {
        const parsed = JSON.parse(body) as T;
        resolve({ ok: true, data: parsed });
      } catch {
        resolve({ ok: false, status: 400, error: 'Invalid JSON payload' });
      }
    });

    req.on('error', (err) => {
      if (!exceeded) {
        resolve({ ok: false, status: 400, error: `Request error: ${err.message}` });
      }
    });
  });
}

export function extractBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers['authorization'];
  if (!authHeader || typeof authHeader !== 'string') {
    return null;
  }

  const parts = authHeader.trim().split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1];
}

export function authenticate(
  req: IncomingMessage,
  db: Database.Database,
  sessionSecret: string
): AuthenticatedContext | null {
  const token = extractBearerToken(req);
  if (!token) {
    return null;
  }

  const payload = verifyToken(token, sessionSecret);
  if (!payload) {
    return null;
  }

  const sessionWithUser = getSessionWithUser(db, payload.sid);
  if (!sessionWithUser) {
    return null;
  }

  if (sessionWithUser.session.userId !== payload.uid) {
    return null;
  }

  return sessionWithUser;
}

export function hasRole(user: UserRecord, ...allowedRoles: HouseholdRole[]): boolean {
  return allowedRoles.includes(user.role);
}
