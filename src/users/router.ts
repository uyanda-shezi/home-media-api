import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import {
  readJsonBody,
  requireRole,
  sendError,
  sendJson,
} from '../auth/middleware.js';
import {
  deleteAllUserSessions,
  getUserById,
  listUsers,
  updateUserRole,
  VALID_ROLES,
  type HouseholdRole,
} from './service.js';

const USER_ROLE_PATH_REGEX = /^\/api\/v1\/users\/([^/]+)\/role\/?$/;
const USER_SESSIONS_PATH_REGEX = /^\/api\/v1\/users\/([^/]+)\/sessions\/?$/;

export async function handleUsersRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  config: AppConfig
): Promise<boolean> {
  const urlPath = req.url?.split('?')[0] || '';

  // 1. GET /api/v1/users
  if (req.method === 'GET' && (urlPath === '/api/v1/users' || urlPath === '/api/v1/users/')) {
    const authCtx = requireRole(req, res, db, config, 'admin');
    if (!authCtx) {
      return true;
    }

    const users = listUsers(db);
    sendJson(res, 200, { users });
    return true;
  }

  // 2. PATCH /api/v1/users/:id/role
  const roleMatch = urlPath.match(USER_ROLE_PATH_REGEX);
  if (req.method === 'PATCH' && roleMatch) {
    const targetUserId = roleMatch[1];

    const authCtx = requireRole(req, res, db, config, 'admin');
    if (!authCtx) {
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

  // 3. DELETE /api/v1/users/:id/sessions (Admin only)
  const sessionMatch = urlPath.match(USER_SESSIONS_PATH_REGEX);
  if (req.method === 'DELETE' && sessionMatch) {
    const authCtx = requireRole(req, res, db, config, 'admin');
    if (!authCtx) {
      return true;
    }

    const targetUserId = sessionMatch[1];
    const targetUser = getUserById(db, targetUserId);
    if (!targetUser) {
      sendError(res, 404, 'User not found');
      return true;
    }

    const revokedCount = deleteAllUserSessions(db, targetUserId);
    sendJson(res, 200, { status: 'ok', userId: targetUserId, revokedCount });
    return true;
  }

  return false;
}
