import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import {
  authenticateWithJellyfin,
  validateJellyfinToken,
} from './jellyfin-auth.js';
import { signToken } from './crypto.js';
import {
  authenticate,
  buildClearSessionCookie,
  buildSessionCookie,
  readJsonBody,
  requireAuth,
  sendError,
  sendJson,
} from './middleware.js';
import {
  deleteAllUserSessions,
  deleteSession,
  deleteUserSession,
  listUserSessions,
  upsertUserAndCreateSession,
} from '../users/service.js';

const AUTH_SESSION_PATH_REGEX = /^\/api\/v1\/auth\/sessions\/([^/]+)\/?$/;

export async function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  config: AppConfig
): Promise<boolean> {
  const urlPath = req.url?.split('?')[0] || '';

  // 1. POST /api/v1/auth/login
  if (req.method === 'POST' && (urlPath === '/api/v1/auth/login' || urlPath === '/api/v1/auth/login/')) {
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

    const maxAgeSeconds = config.sessionTtlDays * 86400;
    const expiresDate = new Date(session.expiresAt);
    const sessionCookie = buildSessionCookie(token, maxAgeSeconds, expiresDate, config.secureCookies);
    res.setHeader('Set-Cookie', sessionCookie);

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
  if (req.method === 'POST' && (urlPath === '/api/v1/auth/logout' || urlPath === '/api/v1/auth/logout/')) {
    const authCtx = requireAuth(req, res, db, config);
    if (!authCtx) {
      return true;
    }

    deleteSession(db, authCtx.session.id);
    const clearCookie = buildClearSessionCookie(config.secureCookies);
    res.setHeader('Set-Cookie', clearCookie);

    sendJson(res, 200, { status: 'ok' });
    return true;
  }

  // 3. GET /api/v1/auth/me
  if (req.method === 'GET' && (urlPath === '/api/v1/auth/me' || urlPath === '/api/v1/auth/me/')) {
    const authCtx = requireAuth(req, res, db, config);
    if (!authCtx) {
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

  // 4. GET /api/v1/auth/validate
  if (req.method === 'GET' && (urlPath === '/api/v1/auth/validate' || urlPath === '/api/v1/auth/validate/')) {
    const authCtx = authenticate(req, db, config.sessionSecret);
    if (!authCtx) {
      sendJson(res, 401, { valid: false, error: 'Unauthorized' });
      return true;
    }

    sendJson(res, 200, {
      valid: true,
      user: {
        id: authCtx.user.id,
        jellyfinUserId: authCtx.user.jellyfinUserId,
        username: authCtx.user.username,
        role: authCtx.user.role,
      },
      session: {
        id: authCtx.session.id,
        expiresAt: authCtx.session.expiresAt,
      },
    });
    return true;
  }

  // 5. POST /api/v1/auth/validate-jellyfin
  if (
    req.method === 'POST' &&
    (urlPath === '/api/v1/auth/validate-jellyfin' || urlPath === '/api/v1/auth/validate-jellyfin/')
  ) {
    const bodyResult = await readJsonBody<{ token?: string }>(req);
    if (!bodyResult.ok) {
      sendError(res, bodyResult.status, bodyResult.error);
      return true;
    }

    const { token } = bodyResult.data;
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      sendError(res, 400, 'Token is required');
      return true;
    }

    const result = await validateJellyfinToken(config.jellyfinUrl, token);
    if (!result.ok) {
      sendError(res, result.error.statusCode, result.error.message);
      return true;
    }

    sendJson(res, 200, {
      valid: true,
      jellyfinUserId: result.data.jellyfinUserId,
      username: result.data.username,
      isAdministrator: result.data.isAdministrator,
    });
    return true;
  }

  // 6. GET /api/v1/auth/sessions
  if (req.method === 'GET' && (urlPath === '/api/v1/auth/sessions' || urlPath === '/api/v1/auth/sessions/')) {
    const authCtx = requireAuth(req, res, db, config);
    if (!authCtx) {
      return true;
    }

    const sessions = listUserSessions(db, authCtx.user.id);
    sendJson(res, 200, {
      sessions: sessions.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        isCurrent: s.id === authCtx.session.id,
      })),
    });
    return true;
  }

  // 7. POST /api/v1/auth/sessions/revoke-all
  if (
    req.method === 'POST' &&
    (urlPath === '/api/v1/auth/sessions/revoke-all' || urlPath === '/api/v1/auth/sessions/revoke-all/')
  ) {
    const authCtx = requireAuth(req, res, db, config);
    if (!authCtx) {
      return true;
    }

    const bodyResult = await readJsonBody<{ keepCurrent?: boolean }>(req);
    const keepCurrent = bodyResult.ok && Boolean(bodyResult.data.keepCurrent);
    const keepId = keepCurrent ? authCtx.session.id : undefined;

    const revokedCount = deleteAllUserSessions(db, authCtx.user.id, keepId);
    if (!keepCurrent) {
      res.setHeader('Set-Cookie', buildClearSessionCookie(config.secureCookies));
    }

    sendJson(res, 200, { status: 'ok', revokedCount });
    return true;
  }

  // 8. DELETE /api/v1/auth/sessions/:id
  const sessionMatch = urlPath.match(AUTH_SESSION_PATH_REGEX);
  if (req.method === 'DELETE' && sessionMatch) {
    const targetSessionId = sessionMatch[1];
    const authCtx = requireAuth(req, res, db, config);
    if (!authCtx) {
      return true;
    }

    const deleted = deleteUserSession(db, authCtx.user.id, targetSessionId);
    if (!deleted) {
      sendError(res, 404, 'Session not found');
      return true;
    }

    if (targetSessionId === authCtx.session.id) {
      res.setHeader('Set-Cookie', buildClearSessionCookie(config.secureCookies));
    }

    sendJson(res, 200, { status: 'ok', revokedSessionId: targetSessionId });
    return true;
  }

  return false;
}
