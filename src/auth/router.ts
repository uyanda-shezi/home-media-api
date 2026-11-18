import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { authenticateWithJellyfin } from './jellyfin-auth.js';
import { signToken } from './crypto.js';
import {
  authenticate,
  readJsonBody,
  sendError,
  sendJson,
} from './middleware.js';
import {
  deleteSession,
  upsertUserAndCreateSession,
} from '../users/service.js';

export async function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  config: AppConfig
): Promise<boolean> {
  const urlPath = req.url?.split('?')[0];

  // 1. POST /api/v1/auth/login
  if (req.method === 'POST' && urlPath === '/api/v1/auth/login') {
    const bodyResult = await readJsonBody<{ username?: string; password?: string }>(req);
    if (!bodyResult.ok) {
      sendError(res, bodyResult.status, bodyResult.error);
      return true;
    }

    const { username, password } = bodyResult.data;
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      sendError(res, 400, 'Username and password are required');
      return true;
    }

    const trimmedUsername = username.trim();
    if (trimmedUsername.length === 0 || password.length === 0) {
      sendError(res, 400, 'Username and password are required');
      return true;
    }

    const authResult = await authenticateWithJellyfin(
      config.jellyfinUrl,
      trimmedUsername,
      password
    );

    if (!authResult.ok) {
      sendError(res, authResult.error.statusCode, authResult.error.message);
      return true;
    }

    // Upsert user and create database session
    const { user, session } = upsertUserAndCreateSession(
      db,
      authResult.data,
      config.sessionTtlDays
    );

    const tokenExpMs = new Date(session.expiresAt).getTime();
    const token = signToken(
      {
        sid: session.id,
        uid: user.id,
        exp: tokenExpMs,
      },
      config.sessionSecret
    );

    sendJson(res, 200, {
      token,
      user: {
        id: user.id,
        jellyfinUserId: user.jellyfinUserId,
        username: user.username,
        role: user.role,
      },
      expiresAt: session.expiresAt,
    });
    return true;
  }

  // 2. POST /api/v1/auth/logout
  if (req.method === 'POST' && urlPath === '/api/v1/auth/logout') {
    const authCtx = authenticate(req, db, config.sessionSecret);
    if (!authCtx) {
      sendError(res, 401, 'Unauthorized');
      return true;
    }

    deleteSession(db, authCtx.session.id);
    sendJson(res, 200, { status: 'ok' });
    return true;
  }

  // 3. GET /api/v1/auth/me
  if (req.method === 'GET' && urlPath === '/api/v1/auth/me') {
    const authCtx = authenticate(req, db, config.sessionSecret);
    if (!authCtx) {
      sendError(res, 401, 'Unauthorized');
      return true;
    }

    sendJson(res, 200, {
      user: {
        id: authCtx.user.id,
        jellyfinUserId: authCtx.user.jellyfinUserId,
        username: authCtx.user.username,
        role: authCtx.user.role,
      },
    });
    return true;
  }

  return false;
}
