-- Migration 0003: Media Identity Mapping, User Preferences, and Unified My List

-- 1. Media Identity Mapping Table
CREATE TABLE IF NOT EXISTS media_items (
  id TEXT PRIMARY KEY,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'series', 'season', 'episode')),
  tmdb_id INTEGER,
  tvdb_id INTEGER,
  imdb_id TEXT,
  jellyfin_item_id TEXT,
  seerr_request_id INTEGER,
  parent_id TEXT REFERENCES media_items(id) ON DELETE CASCADE,
  season_number INTEGER,
  episode_number INTEGER,
  title TEXT NOT NULL,
  original_title TEXT,
  release_date TEXT,
  poster_path TEXT,
  backdrop_path TEXT,
  overview TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_items_tmdb ON media_items(media_type, tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_items_jellyfin ON media_items(jellyfin_item_id) WHERE jellyfin_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_items_seerr_request ON media_items(seerr_request_id) WHERE seerr_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_items_parent_id ON media_items(parent_id);
CREATE INDEX IF NOT EXISTS idx_media_items_tvdb ON media_items(tvdb_id) WHERE tvdb_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_items_imdb ON media_items(imdb_id) WHERE imdb_id IS NOT NULL;

-- 2. User Preferences Table
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auto_watchlist_requests INTEGER NOT NULL DEFAULT 1 CHECK (auto_watchlist_requests IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3. Unified My List Table
CREATE TABLE IF NOT EXISTS my_list (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  user_intent TEXT NOT NULL DEFAULT 'saved' CHECK (user_intent IN ('saved', 'not_saved')),
  acquisition_state TEXT NOT NULL DEFAULT 'not_requested' CHECK (acquisition_state IN ('not_requested', 'pending', 'processing', 'partially_available', 'available', 'failed')),
  playback_state TEXT NOT NULL DEFAULT 'unwatched' CHECK (playback_state IN ('unwatched', 'in_progress', 'watched')),
  playback_position_ticks INTEGER NOT NULL DEFAULT 0,
  playback_percentage REAL NOT NULL DEFAULT 0.0,
  last_played_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_my_list_user_intent ON my_list(user_id, user_intent);
CREATE INDEX IF NOT EXISTS idx_my_list_user_acquisition ON my_list(user_id, acquisition_state);
CREATE INDEX IF NOT EXISTS idx_my_list_user_playback ON my_list(user_id, playback_state);
CREATE INDEX IF NOT EXISTS idx_my_list_media_id ON my_list(media_id);

-- 4. Update Schema Version
INSERT OR REPLACE INTO system_metadata (key, value, updated_at)
VALUES ('schema_version', '3', datetime('now'));
