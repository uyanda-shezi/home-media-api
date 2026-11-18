import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import {
  authenticate,
  hasRole,
  readJsonBody,
  sendError,
  sendJson,
} from '../auth/middleware.js';
import {
  listUsers,
  updateUserRole,
  VALID_ROLES,
  type HouseholdRole,
} from './service.js';

const USER_ROLE_PATH_REGEX = /^\/api\/v1\/users\/([^/]+)\/role\/?$/;

export async function handleUsersRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  config: AppConfig
): Promise<boolean> {
  const urlPath = req.url?.split('?')[0] || '';

  // 1. GET /api/v1/users
  if (req.method === 'GET' && (urlPath === '/api/v1/users' || urlPath === '/api/v1/users/')) {
    const authCtx = authenticate(req, db, config.sessionSecret);
    if (!authCtx) {
      sendError(res, 401, 'Unauthorized');
      return true;
    }

    if (!hasRole(authCtx.user, 'admin')) {
      sendError(res, 403, 'Forbidden: Insufficient household role');
      return true;
    }

    const users = listUsers(db);
    sendJson(res, 200, { users });
    return true;
  }

  // 2. PATCH /api/v1/users/:id/role
  const match = urlPath.match(USER_ROLE_PATH_REGEX);
  if (req.method === 'PATCH' && match) {
    const targetUserId = match[1];

    const authCtx = authenticate(req, db, config.sessionSecret);
    if (!authCtx) {
      sendError(res, 401, 'Unauthorized');
      return true;
    }

    if (!hasRole(authCtx.user, 'admin')) {
      sendError(res, 403, 'Forbidden: Insufficient household role');
      return true;
    }

    const bodyResult = await readJsonBody<{ role?: string }>(req);
    if (!bodyResult.ok) {
      sendError(res, bodyResult.status, bodyResult.error);
      return true;
    }

    const { role } = bodyResult.data;
    if (!role || typeof role !== 'string' || !VALID_ROLES.includes(role as HouseholdRole)) {
      sendError(res, 400, 'Invalid role specified');
      return true;
    }

    const updateResult = updateUserRole(db, targetUserId, role);
    if (!updateResult.ok) {
      sendError(res, updateResult.status, updateResult.error);
      return true;
    }

    sendJson(res, 200, { user: updateResult.user });
    return true;
  }

  return false;
}
