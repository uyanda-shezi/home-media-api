import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AcquisitionState,
  MediaItemRecord,
  MyListFilterOptions,
  MyListItemView,
  MyListPaginatedResult,
  MyListRecord,
  PlaybackState,
  UpsertMediaInput,
  UserIntent,
  UserPreferences,
} from './types.js';

export function getUserPreferences(
  db: Database.Database,
  userId: string
): UserPreferences {
  const row = db
    .prepare(
      `SELECT auto_watchlist_requests FROM user_preferences WHERE user_id = ?`
    )
    .get(userId) as { auto_watchlist_requests: number } | undefined;

  if (!row) {
    return { autoWatchlistRequests: true };
  }

  return {
    autoWatchlistRequests: row.auto_watchlist_requests === 1,
  };
}

export function updateUserPreferences(
  db: Database.Database,
  userId: string,
  prefs: Partial<UserPreferences>
): UserPreferences {
  const current = getUserPreferences(db, userId);
  const updatedAutoWatchlist =
    prefs.autoWatchlistRequests !== undefined
      ? prefs.autoWatchlistRequests
      : current.autoWatchlistRequests;

  const intVal = updatedAutoWatchlist ? 1 : 0;

  db.prepare(
    `INSERT INTO user_preferences (user_id, auto_watchlist_requests, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       auto_watchlist_requests = excluded.auto_watchlist_requests,
       updated_at = datetime('now')`
  ).run(userId, intVal);

  return { autoWatchlistRequests: updatedAutoWatchlist };
}

export function findMediaItemById(
  db: Database.Database,
  id: string
): MediaItemRecord | null {
  const row = db
    .prepare(`SELECT * FROM media_items WHERE id = ?`)
    .get(id) as MediaItemRecord | undefined;
  return row || null;
}

export function findMediaItemByExternalIds(
  db: Database.Database,
  identifiers: {
    tmdbId?: number;
    mediaType?: string;
    tvdbId?: number;
    jellyfinItemId?: string;
  }
): MediaItemRecord | null {
  if (identifiers.tmdbId && identifiers.mediaType) {
    const row = db
      .prepare(
        `SELECT * FROM media_items WHERE tmdb_id = ? AND media_type = ?`
      )
      .get(identifiers.tmdbId, identifiers.mediaType) as MediaItemRecord | undefined;
    if (row) return row;
  }

  if (identifiers.jellyfinItemId) {
    const row = db
      .prepare(`SELECT * FROM media_items WHERE jellyfin_item_id = ?`)
      .get(identifiers.jellyfinItemId) as MediaItemRecord | undefined;
    if (row) return row;
  }

  if (identifiers.tvdbId) {
    const row = db
      .prepare(`SELECT * FROM media_items WHERE tvdb_id = ?`)
      .get(identifiers.tvdbId) as MediaItemRecord | undefined;
    if (row) return row;
  }

  return null;
}

export function upsertMediaItem(
  db: Database.Database,
  input: UpsertMediaInput
): MediaItemRecord {
  const existing = findMediaItemByExternalIds(db, {
    tmdbId: input.tmdbId,
    mediaType: input.mediaType,
    tvdbId: input.tvdbId,
    jellyfinItemId: input.jellyfinItemId,
  });

  if (existing) {
    db.prepare(
      `UPDATE media_items SET
        tmdb_id = COALESCE(?, tmdb_id),
        tvdb_id = COALESCE(?, tvdb_id),
        imdb_id = COALESCE(?, imdb_id),
        jellyfin_item_id = COALESCE(?, jellyfin_item_id),
        seerr_request_id = COALESCE(?, seerr_request_id),
        title = COALESCE(?, title),
        original_title = COALESCE(?, original_title),
        release_date = COALESCE(?, release_date),
        poster_path = COALESCE(?, poster_path),
        backdrop_path = COALESCE(?, backdrop_path),
        overview = COALESCE(?, overview),
        updated_at = datetime('now')
      WHERE id = ?`
    ).run(
      input.tmdbId ?? null,
      input.tvdbId ?? null,
      input.imdbId ?? null,
      input.jellyfinItemId ?? null,
      input.seerrRequestId ?? null,
      input.title ?? null,
      input.originalTitle ?? null,
      input.releaseDate ?? null,
      input.posterPath ?? null,
      input.backdropPath ?? null,
      input.overview ?? null,
      existing.id
    );

    return findMediaItemById(db, existing.id)!;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_items (
      id, media_type, tmdb_id, tvdb_id, imdb_id, jellyfin_item_id, seerr_request_id,
      title, original_title, release_date, poster_path, backdrop_path, overview,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(
    id,
    input.mediaType,
    input.tmdbId ?? null,
    input.tvdbId ?? null,
    input.imdbId ?? null,
    input.jellyfinItemId ?? null,
    input.seerrRequestId ?? null,
    input.title,
    input.originalTitle ?? null,
    input.releaseDate ?? null,
    input.posterPath ?? null,
    input.backdropPath ?? null,
    input.overview ?? null
  );

  return findMediaItemById(db, id)!;
}

export function upsertMediaItemAndWatchlist(
  db: Database.Database,
  userId: string,
  payload:
    | { mediaId: string; intent?: UserIntent }
    | { media: UpsertMediaInput; intent?: UserIntent }
): MyListItemView {
  return db.transaction(() => {
    let mediaItem: MediaItemRecord | null = null;

    if ('mediaId' in payload && payload.mediaId) {
      mediaItem = findMediaItemById(db, payload.mediaId);
      if (!mediaItem) {
        throw new Error(`Media item not found with id: ${payload.mediaId}`);
      }
    } else if ('media' in payload && payload.media) {
      mediaItem = upsertMediaItem(db, payload.media);
    } else {
      throw new Error('Invalid media specification in request');
    }

    const targetIntent: UserIntent = payload.intent || 'saved';

    const existingMyList = db
      .prepare(`SELECT * FROM my_list WHERE user_id = ? AND media_id = ?`)
      .get(userId, mediaItem.id) as MyListRecord | undefined;

    if (existingMyList) {
      db.prepare(
        `UPDATE my_list SET
          user_intent = ?,
          updated_at = datetime('now')
        WHERE user_id = ? AND media_id = ?`
      ).run(targetIntent, userId, mediaItem.id);
    } else {
      const myListId = randomUUID();
      db.prepare(
        `INSERT INTO my_list (
          id, user_id, media_id, user_intent, acquisition_state, playback_state,
          playback_position_ticks, playback_percentage, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'not_requested', 'unwatched', 0, 0.0, datetime('now'), datetime('now'))`
      ).run(myListId, userId, mediaItem.id, targetIntent);
    }

    const item = getMyListItem(db, userId, mediaItem.id);
    if (!item) {
      throw new Error('Failed to retrieve upserted My List item');
    }
    return item;
  })();
}

export function linkSeerrRequestAndWatchlist(
  db: Database.Database,
  userId: string,
  params: {
    tmdbId: number;
    mediaType: 'movie' | 'series';
    seerrRequestId: number;
    title?: string;
    posterPath?: string;
  }
): void {
  db.transaction(() => {
    // 1. Resolve or create media_items record
    let mediaItem = findMediaItemByExternalIds(db, {
      tmdbId: params.tmdbId,
      mediaType: params.mediaType,
    });

    if (mediaItem) {
      db.prepare(
        `UPDATE media_items SET
          seerr_request_id = ?,
          title = COALESCE(?, title),
          poster_path = COALESCE(?, poster_path),
          updated_at = datetime('now')
        WHERE id = ?`
      ).run(params.seerrRequestId, params.title ?? null, params.posterPath ?? null, mediaItem.id);
      mediaItem = findMediaItemById(db, mediaItem.id)!;
    } else {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO media_items (
          id, media_type, tmdb_id, seerr_request_id, title, poster_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(
        id,
        params.mediaType,
        params.tmdbId,
        params.seerrRequestId,
        params.title || `Title ${params.tmdbId}`,
        params.posterPath ?? null
      );
      mediaItem = findMediaItemById(db, id)!;
    }

    // 2. Query user preferences
    const prefs = getUserPreferences(db, userId);

    // 3. Query existing my_list record
    const existing = db
      .prepare(`SELECT * FROM my_list WHERE user_id = ? AND media_id = ?`)
      .get(userId, mediaItem.id) as MyListRecord | undefined;

    if (existing) {
      // NON-DESTRUCTIVE INTENT INVARIANT:
      // Update acquisition_state = 'pending', leaving user_intent untouched!
      db.prepare(
        `UPDATE my_list SET
          acquisition_state = 'pending',
          updated_at = datetime('now')
        WHERE user_id = ? AND media_id = ?`
      ).run(userId, mediaItem.id);
    } else {
      const intent: UserIntent = prefs.autoWatchlistRequests ? 'saved' : 'not_saved';
      const myListId = randomUUID();
      db.prepare(
        `INSERT INTO my_list (
          id, user_id, media_id, user_intent, acquisition_state, playback_state,
          playback_position_ticks, playback_percentage, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 'unwatched', 0, 0.0, datetime('now'), datetime('now'))`
      ).run(myListId, userId, mediaItem.id, intent);
    }
  })();
}

export function removeWatchlistIntent(
  db: Database.Database,
  userId: string,
  mediaId: string
): boolean {
  // Non-destructive removal: set user_intent = 'not_saved', never delete row
  const info = db
    .prepare(
      `UPDATE my_list SET
        user_intent = 'not_saved',
        updated_at = datetime('now')
      WHERE user_id = ? AND (media_id = ? OR id = ?)`
    )
    .run(userId, mediaId, mediaId);

  return info.changes > 0;
}

export function updateAcquisitionState(
  db: Database.Database,
  mediaId: string,
  state: AcquisitionState
): void {
  // Updates acquisition_state across any user rows for this media, never touches user_intent
  db.prepare(
    `UPDATE my_list SET
      acquisition_state = ?,
      updated_at = datetime('now')
    WHERE media_id = ?`
  ).run(state, mediaId);
}

export function updatePlaybackState(
  db: Database.Database,
  userId: string,
  mediaId: string,
  state: PlaybackState,
  positionTicks: number = 0,
  percentage: number = 0.0
): void {
  // Updates playback columns only, never touches user_intent
  db.prepare(
    `UPDATE my_list SET
      playback_state = ?,
      playback_position_ticks = ?,
      playback_percentage = ?,
      last_played_at = datetime('now'),
      updated_at = datetime('now')
    WHERE user_id = ? AND media_id = ?`
  ).run(state, positionTicks, percentage, userId, mediaId);
}

function mapRowToView(row: any): MyListItemView {
  return {
    id: row.mylist_id,
    mediaId: row.media_id,
    media: {
      id: row.media_id,
      mediaType: row.media_type,
      tmdbId: row.tmdb_id,
      tvdbId: row.tvdb_id,
      imdbId: row.imdb_id,
      jellyfinItemId: row.jellyfin_item_id,
      seerrRequestId: row.seerr_request_id,
      title: row.title,
      originalTitle: row.original_title,
      overview: row.overview,
      releaseDate: row.release_date,
      posterPath: row.poster_path,
      backdropPath: row.backdrop_path,
    },
    userIntent: row.user_intent,
    acquisitionState: row.acquisition_state,
    playbackState: row.playback_state,
    playback: {
      positionTicks: row.playback_position_ticks || 0,
      percentage: row.playback_percentage || 0.0,
      lastPlayedAt: row.last_played_at,
    },
    createdAt: row.mylist_created_at,
    updatedAt: row.mylist_updated_at,
  };
}

export function getMyList(
  db: Database.Database,
  userId: string,
  options: MyListFilterOptions = {}
): MyListPaginatedResult {
  const page = Math.max(1, options.page || 1);
  const limit = Math.max(1, Math.min(options.limit || 20, 100));
  const offset = (page - 1) * limit;

  const whereClauses: string[] = ['ml.user_id = ?'];
  const params: any[] = [userId];

  // 1. Intent filter (default: 'saved')
  const intent = options.intent || 'saved';
  if (intent !== 'all') {
    whereClauses.push('ml.user_intent = ?');
    params.push(intent);
  }

  // 2. Acquisition filter
  if (options.acquisition && options.acquisition !== 'all') {
    whereClauses.push('ml.acquisition_state = ?');
    params.push(options.acquisition);
  }

  // 3. Playback filter
  if (options.playback && options.playback !== 'all') {
    whereClauses.push('ml.playback_state = ?');
    params.push(options.playback);
  }

  // 4. Media type filter
  if (options.mediaType && options.mediaType !== 'all') {
    whereClauses.push('m.media_type = ?');
    params.push(options.mediaType);
  }

  const whereSql = whereClauses.join(' AND ');

  // Sorting
  const sortCol =
    options.sort === 'created_at'
      ? 'ml.created_at'
      : options.sort === 'title'
      ? 'm.title'
      : options.sort === 'last_played_at'
      ? 'ml.last_played_at'
      : 'ml.updated_at';

  const orderDir = options.order === 'asc' ? 'ASC' : 'DESC';

  const countQuery = `
    SELECT COUNT(*) as total
    FROM my_list ml
    JOIN media_items m ON ml.media_id = m.id
    WHERE ${whereSql}
  `;
  const countRow = db.prepare(countQuery).get(...params) as { total: number };
  const total = countRow?.total || 0;

  const selectQuery = `
    SELECT
      ml.id as mylist_id,
      ml.user_id,
      ml.media_id,
      ml.user_intent,
      ml.acquisition_state,
      ml.playback_state,
      ml.playback_position_ticks,
      ml.playback_percentage,
      ml.last_played_at,
      ml.created_at as mylist_created_at,
      ml.updated_at as mylist_updated_at,
      m.media_type,
      m.tmdb_id,
      m.tvdb_id,
      m.imdb_id,
      m.jellyfin_item_id,
      m.seerr_request_id,
      m.title,
      m.original_title,
      m.overview,
      m.release_date,
      m.poster_path,
      m.backdrop_path
    FROM my_list ml
    JOIN media_items m ON ml.media_id = m.id
    WHERE ${whereSql}
    ORDER BY ${sortCol} ${orderDir}
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(selectQuery).all(...params, limit, offset);
  const items = rows.map(mapRowToView);

  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    items,
  };
}

export function getMyListItem(
  db: Database.Database,
  userId: string,
  mediaIdOrRecordId: string
): MyListItemView | null {
  const query = `
    SELECT
      ml.id as mylist_id,
      ml.user_id,
      ml.media_id,
      ml.user_intent,
      ml.acquisition_state,
      ml.playback_state,
      ml.playback_position_ticks,
      ml.playback_percentage,
      ml.last_played_at,
      ml.created_at as mylist_created_at,
      ml.updated_at as mylist_updated_at,
      m.media_type,
      m.tmdb_id,
      m.tvdb_id,
      m.imdb_id,
      m.jellyfin_item_id,
      m.seerr_request_id,
      m.title,
      m.original_title,
      m.overview,
      m.release_date,
      m.poster_path,
      m.backdrop_path
    FROM my_list ml
    JOIN media_items m ON ml.media_id = m.id
    WHERE ml.user_id = ? AND (ml.media_id = ? OR ml.id = ?)
  `;

  const row = db.prepare(query).get(userId, mediaIdOrRecordId, mediaIdOrRecordId);
  if (!row) return null;
  return mapRowToView(row);
}

export function getMyListStatus(
  db: Database.Database,
  userId: string,
  identifiers: {
    mediaId?: string;
    tmdbId?: number;
    mediaType?: string;
    jellyfinItemId?: string;
  }
): {
  mediaId: string | null;
  userIntent: UserIntent;
  acquisitionState: AcquisitionState;
  playbackState: PlaybackState;
  playback: {
    positionTicks: number;
    percentage: number;
    lastPlayedAt: string | null;
  };
} {
  let mediaItem: MediaItemRecord | null = null;

  if (identifiers.mediaId) {
    mediaItem = findMediaItemById(db, identifiers.mediaId);
  } else {
    mediaItem = findMediaItemByExternalIds(db, identifiers);
  }

  if (!mediaItem) {
    return {
      mediaId: null,
      userIntent: 'not_saved',
      acquisitionState: 'not_requested',
      playbackState: 'unwatched',
      playback: {
        positionTicks: 0,
        percentage: 0.0,
        lastPlayedAt: null,
      },
    };
  }

  const myListRow = db
    .prepare(`SELECT * FROM my_list WHERE user_id = ? AND media_id = ?`)
    .get(userId, mediaItem.id) as MyListRecord | undefined;

  if (!myListRow) {
    return {
      mediaId: mediaItem.id,
      userIntent: 'not_saved',
      acquisitionState: 'not_requested',
      playbackState: 'unwatched',
      playback: {
        positionTicks: 0,
        percentage: 0.0,
        lastPlayedAt: null,
      },
    };
  }

  return {
    mediaId: mediaItem.id,
    userIntent: myListRow.user_intent,
    acquisitionState: myListRow.acquisition_state,
    playbackState: myListRow.playback_state,
    playback: {
      positionTicks: myListRow.playback_position_ticks || 0,
      percentage: myListRow.playback_percentage || 0.0,
      lastPlayedAt: myListRow.last_played_at,
    },
  };
}
