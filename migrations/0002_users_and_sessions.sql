CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  jellyfin_user_id TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'standard', 'request_only')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jellyfin_access_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
