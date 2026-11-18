import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { JellyfinAuthData } from '../auth/jellyfin-auth.js';

export type HouseholdRole = 'admin' | 'standard' | 'request_only';

export const VALID_ROLES: readonly HouseholdRole[] = ['admin', 'standard', 'request_only'] as const;

export interface UserRecord {
  id: string;
  jellyfinUserId: string;
  username: string;
  role: HouseholdRole;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  jellyfinAccessToken: string;
  expiresAt: string;
  createdAt: string;
}

interface RawUserRow {
  id: string;
  jellyfin_user_id: string;
  username: string;
  role: string;
  created_at: string;
  updated_at: string;
}

interface RawSessionRow {
  id: string;
  user_id: string;
  jellyfin_access_token: string;
  expires_at: string;
  created_at: string;
}

function mapUserRow(row: RawUserRow): UserRecord {
  return {
    id: row.id,
    jellyfinUserId: row.jellyfin_user_id,
    username: row.username,
    role: row.role as HouseholdRole,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSessionRow(row: RawSessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    jellyfinAccessToken: row.jellyfin_access_token,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function getUserById(db: Database.Database, id: string): UserRecord | null {
  const row = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(id) as RawUserRow | undefined;
  return row ? mapUserRow(row) : null;
}

export function getUserByJellyfinId(db: Database.Database, jellyfinUserId: string): UserRecord | null {
  const row = db
    .prepare('SELECT * FROM users WHERE jellyfin_user_id = ?')
    .get(jellyfinUserId) as RawUserRow | undefined;
  return row ? mapUserRow(row) : null;
}

export function listUsers(db: Database.Database): UserRecord[] {
  const rows = db
    .prepare('SELECT * FROM users ORDER BY created_at ASC')
    .all() as RawUserRow[];
  return rows.map(mapUserRow);
}

export function countAdmins(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")
    .get() as { count: number };
  return row.count;
}

export function updateUserRole(
  db: Database.Database,
  userId: string,
  newRole: string
): { ok: true; user: UserRecord } | { ok: false; status: number; error: string } {
  if (!VALID_ROLES.includes(newRole as HouseholdRole)) {
    return { ok: false, status: 400, error: 'Invalid role specified' };
  }

  const user = getUserById(db, userId);
  if (!user) {
    return { ok: false, status: 404, error: 'User not found' };
  }

  // Last-Admin Safety Guard:
  // If demoting an admin to a non-admin role, ensure at least one other admin exists
  if (user.role === 'admin' && newRole !== 'admin') {
    const adminCount = countAdmins(db);
    if (adminCount <= 1) {
      return {
        ok: false,
        status: 400,
        error: 'Cannot demote the last remaining household admin',
      };
    }
  }

  db.prepare(`
    UPDATE users
    SET role = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(newRole, userId);

  const updated = getUserById(db, userId)!;
  return { ok: true, user: updated };
}

export function upsertUserAndCreateSession(
  db: Database.Database,
  authData: JellyfinAuthData,
  ttlDays: number = 7
): { user: UserRecord; session: SessionRecord } {
  const execute = db.transaction(() => {
    // 1. Opportunistic Session Pruning
    db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();

    // 2. Check if user already exists
    let user = getUserByJellyfinId(db, authData.userId);

    if (user) {
      // Preserve existing household role; update username and timestamp
      db.prepare(`
        UPDATE users
        SET username = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(authData.username, user.id);
      user = getUserById(db, user.id)!;
    } else {
      // First-time login: role defaults to 'admin' if Jellyfin administrator, else 'standard'
      const assignedRole: HouseholdRole = authData.isAdministrator ? 'admin' : 'standard';
      const newUserId = randomUUID();

      db.prepare(`
        INSERT INTO users (id, jellyfin_user_id, username, role)
        VALUES (?, ?, ?, ?)
      `).run(newUserId, authData.userId, authData.username, assignedRole);

      user = getUserById(db, newUserId)!;
    }

    // 3. Create Session
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO sessions (id, user_id, jellyfin_access_token, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, user.id, authData.accessToken, expiresAt);

    const rawSession = db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId) as RawSessionRow;

    return {
      user,
      session: mapSessionRow(rawSession),
    };
  }).immediate;

  return execute();
}

export function deleteSession(db: Database.Database, sessionId: string): boolean {
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  return result.changes > 0;
}

export function getSessionWithUser(
  db: Database.Database,
  sessionId: string
): { session: SessionRecord; user: UserRecord } | null {
  const row = db
    .prepare(`
      SELECT 
        s.id as session_id,
        s.user_id as session_user_id,
        s.jellyfin_access_token,
        s.expires_at,
        s.created_at as session_created_at,
        u.id as user_id,
        u.jellyfin_user_id,
        u.username,
        u.role,
        u.created_at as user_created_at,
        u.updated_at as user_updated_at
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.expires_at > datetime('now')
    `)
    .get(sessionId) as
    | {
        session_id: string;
        session_user_id: string;
        jellyfin_access_token: string;
        expires_at: string;
        session_created_at: string;
        user_id: string;
        jellyfin_user_id: string;
        username: string;
        role: string;
        user_created_at: string;
        user_updated_at: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    session: {
      id: row.session_id,
      userId: row.session_user_id,
      jellyfinAccessToken: row.jellyfin_access_token,
      expiresAt: row.expires_at,
      createdAt: row.session_created_at,
    },
    user: {
      id: row.user_id,
      jellyfinUserId: row.jellyfin_user_id,
      username: row.username,
      role: row.role as HouseholdRole,
      createdAt: row.user_created_at,
      updatedAt: row.user_updated_at,
    },
  };
}
