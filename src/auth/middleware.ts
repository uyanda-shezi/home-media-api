import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { verifyToken } from './crypto.js';
import {
  getSessionWithUser,
  type HouseholdRole,
  type SessionRecord,
  type UserRecord,
} from '../users/service.js';

export const SESSION_COOKIE_NAME = 'hm_session';

export const ROLE_HIERARCHY: Record<HouseholdRole, number> = {
  admin: 3,
  standard: 2,
  request_only: 1,
};

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

export function parseCookies(cookieHeader?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return cookies;
  }

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key.length > 0) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

export function extractSessionCookie(
  req: IncomingMessage,
  cookieName: string = SESSION_COOKIE_NAME
): string | null {
  const cookieHeader = req.headers['cookie'];
  if (!cookieHeader) return null;
  const rawHeader = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
  const cookies = parseCookies(rawHeader);
  return cookies[cookieName] || null;
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

export function extractAuthToken(req: IncomingMessage): string | null {
  // 1. Authorization: Bearer <token>
  const bearer = extractBearerToken(req);
  if (bearer) return bearer;

  // 2. Cookie: hm_session=<token>
  const cookieToken = extractSessionCookie(req);
  if (cookieToken) return cookieToken;

  return null;
}

export function buildSessionCookie(
  token: string,
  maxAgeSeconds: number,
  expiresDate: Date,
  secure: boolean = false
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    `Expires=${expiresDate.toUTCString()}`,
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function buildClearSessionCookie(secure: boolean = false): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function authenticate(
  req: IncomingMessage,
  db: Database.Database,
  sessionSecret: string
): AuthenticatedContext | null {
  const token = extractAuthToken(req);
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

export function hasMinimumRole(user: UserRecord, minRole: HouseholdRole): boolean {
  const userLevel = ROLE_HIERARCHY[user.role] ?? 0;
  const requiredLevel = ROLE_HIERARCHY[minRole] ?? 99;
  return userLevel >= requiredLevel;
}

export function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  config: AppConfig
): AuthenticatedContext | null {
  const authCtx = authenticate(req, db, config.sessionSecret);
  if (!authCtx) {
    sendError(res, 401, 'Unauthorized');
    return null;
  }
  return authCtx;
}

export function requireRole(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  config: AppConfig,
  ...allowedRoles: HouseholdRole[]
): AuthenticatedContext | null {
  const authCtx = requireAuth(req, res, db, config);
  if (!authCtx) return null;

  if (!hasRole(authCtx.user, ...allowedRoles)) {
    sendError(res, 403, 'Forbidden: Insufficient household role');
    return null;
  }

  return authCtx;
}

export function requireMinimumRole(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  config: AppConfig,
  minRole: HouseholdRole
): AuthenticatedContext | null {
  const authCtx = requireAuth(req, res, db, config);
  if (!authCtx) return null;

  if (!hasMinimumRole(authCtx.user, minRole)) {
    sendError(res, 403, 'Forbidden: Insufficient household role');
    return null;
  }

  return authCtx;
}
