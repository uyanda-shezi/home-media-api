import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import {
  readJsonBody,
  requireAuth,
  sendError,
  sendJson,
} from '../auth/middleware.js';
import {
  getMyList,
  getMyListItem,
  getMyListStatus,
  getUserPreferences,
  removeWatchlistIntent,
  updateUserPreferences,
  upsertMediaItemAndWatchlist,
} from './service.js';
import type {
  AcquisitionState,
  MediaType,
  PlaybackState,
  UserIntent,
} from './types.js';

const MY_LIST_ITEM_ACTION_REGEX = /^\/api\/v1\/my-list\/items\/([^/]+)\/?$/;
const MY_LIST_STATUS_REGEX = /^\/api\/v1\/my-list\/status(?:\/([^/]+))?\/?$/;
const SINGLE_MY_LIST_REGEX = /^\/api\/v1\/my-list\/([^/]+)\/?$/;

function parseQuery(url: string | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) return new URLSearchParams();
  return new URLSearchParams(url.slice(queryIndex + 1));
}

const VALID_INTENTS = ['saved', 'not_saved', 'all'] as const;
const VALID_ACQUISITION_STATES = [
  'all',
  'not_requested',
  'pending',
  'processing',
  'partially_available',
  'available',
  'failed',
] as const;
const VALID_PLAYBACK_STATES = ['all', 'unwatched', 'in_progress', 'watched'] as const;
const VALID_MEDIA_TYPES = ['all', 'movie', 'series'] as const;
const VALID_SORT_FIELDS = ['updated_at', 'created_at', 'title', 'last_played_at'] as const;

export async function handleMyListRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  config: AppConfig
): Promise<boolean> {
  const fullUrl = req.url || '';
  const urlPath = fullUrl.split('?')[0];

  const isMyListRoute = urlPath.startsWith('/api/v1/my-list');
  const isPreferencesRoute =
    urlPath === '/api/v1/users/me/preferences' ||
    urlPath === '/api/v1/users/me/preferences/';

  if (!isMyListRoute && !isPreferencesRoute) {
    return false;
  }

  // 1. Strict Authentication Guard (Cryptographic user session binding)
  const authCtx = requireAuth(req, res, db, config);
  if (!authCtx) return true;

  const userId = authCtx.user.id;
  const query = parseQuery(fullUrl);

  try {
    // 2. GET & PATCH /api/v1/users/me/preferences
    if (isPreferencesRoute) {
      if (req.method === 'GET') {
        const prefs = getUserPreferences(db, userId);
        sendJson(res, 200, prefs);
        return true;
      }

      if (req.method === 'PATCH') {
        const bodyResult = await readJsonBody<any>(req);
        if (!bodyResult.ok) {
          sendError(res, bodyResult.status, bodyResult.error);
          return true;
        }

        const body = bodyResult.data;
        if (!body || typeof body !== 'object') {
          sendError(res, 400, 'Invalid JSON body');
          return true;
        }

        if (
          body.autoWatchlistRequests !== undefined &&
          typeof body.autoWatchlistRequests !== 'boolean'
        ) {
          sendError(res, 400, 'autoWatchlistRequests must be a boolean');
          return true;
        }

        const updated = updateUserPreferences(db, userId, {
          autoWatchlistRequests: body.autoWatchlistRequests,
        });

        sendJson(res, 200, { status: 'ok', preferences: updated });
        return true;
      }
    }

    // 3. GET /api/v1/my-list/status/:mediaId or /api/v1/my-list/status?tmdbId=...
    const statusMatch = urlPath.match(MY_LIST_STATUS_REGEX);
    if (req.method === 'GET' && statusMatch) {
      const mediaIdParam = statusMatch[1];
      const tmdbIdRaw = query.get('tmdbId');
      const mediaTypeRaw = query.get('mediaType');
      const jellyfinItemId = query.get('jellyfinItemId') || undefined;

      const tmdbId = tmdbIdRaw ? parseInt(tmdbIdRaw, 10) : undefined;
      const mediaType = mediaTypeRaw || undefined;

      const status = getMyListStatus(db, userId, {
        mediaId: mediaIdParam || undefined,
        tmdbId: !isNaN(tmdbId || NaN) ? tmdbId : undefined,
        mediaType,
        jellyfinItemId,
      });

      sendJson(res, 200, status);
      return true;
    }

    // 4. DELETE /api/v1/my-list/items/:mediaId
    const itemActionMatch = urlPath.match(MY_LIST_ITEM_ACTION_REGEX);
    if (req.method === 'DELETE' && itemActionMatch) {
      const mediaId = itemActionMatch[1];
      const removed = removeWatchlistIntent(db, userId, mediaId);
      if (!removed) {
        sendError(res, 404, 'Media item not found in your list');
        return true;
      }

      sendJson(res, 200, {
        status: 'removed',
        mediaId,
        userIntent: 'not_saved',
      });
      return true;
    }

    // 5. POST /api/v1/my-list/items
    if (
      req.method === 'POST' &&
      (urlPath === '/api/v1/my-list/items' || urlPath === '/api/v1/my-list/items/')
    ) {
      const bodyResult = await readJsonBody<any>(req);
      if (!bodyResult.ok) {
        sendError(res, bodyResult.status, bodyResult.error);
        return true;
      }

      const body = bodyResult.data;
      if (!body || typeof body !== 'object') {
        sendError(res, 400, 'Invalid JSON body');
        return true;
      }

      const intent = (body.intent || 'saved') as UserIntent;
      if (intent !== 'saved' && intent !== 'not_saved') {
        sendError(res, 400, "intent must be 'saved' or 'not_saved'");
        return true;
      }

      if (body.mediaId && typeof body.mediaId === 'string') {
        try {
          const item = upsertMediaItemAndWatchlist(db, userId, {
            mediaId: body.mediaId,
            intent,
          });
          sendJson(res, 200, { status: 'ok', item });
          return true;
        } catch (err: any) {
          sendError(res, 404, err.message || 'Media item not found');
          return true;
        }
      }

      // Fresh title with external provider IDs
      const mediaType = body.mediaType as MediaType;
      if (mediaType === 'season' || mediaType === 'episode') {
        sendError(
          res,
          400,
          "Cannot add individual 'season' or 'episode' directly to My List; add the parent series"
        );
        return true;
      }

      if (mediaType !== 'movie' && mediaType !== 'series') {
        sendError(res, 400, "mediaType must be 'movie' or 'series'");
        return true;
      }

      const tmdbId = body.tmdbId ? parseInt(body.tmdbId, 10) : undefined;
      const title = body.title?.trim();
      if (!title) {
        sendError(res, 400, 'title is required when creating a new media item');
        return true;
      }

      const item = upsertMediaItemAndWatchlist(db, userId, {
        media: {
          mediaType,
          tmdbId: !isNaN(tmdbId || NaN) ? tmdbId : undefined,
          tvdbId: body.tvdbId ? parseInt(body.tvdbId, 10) : undefined,
          imdbId: body.imdbId?.trim() || undefined,
          jellyfinItemId: body.jellyfinItemId?.trim() || undefined,
          title,
          originalTitle: body.originalTitle?.trim() || undefined,
          releaseDate: body.releaseDate || undefined,
          posterPath: body.posterPath || undefined,
          backdropPath: body.backdropPath || undefined,
          overview: body.overview || undefined,
        },
        intent,
      });

      sendJson(res, 200, { status: 'ok', item });
      return true;
    }

    // 6. GET /api/v1/my-list
    if (
      req.method === 'GET' &&
      (urlPath === '/api/v1/my-list' || urlPath === '/api/v1/my-list/')
    ) {
      const intentParam = query.get('intent') || 'saved';
      if (!VALID_INTENTS.includes(intentParam as any)) {
        sendError(res, 400, "Invalid intent. Must be 'saved', 'not_saved', or 'all'");
        return true;
      }

      const acqParam = query.get('acquisition') || 'all';
      if (!VALID_ACQUISITION_STATES.includes(acqParam as any)) {
        sendError(
          res,
          400,
          `Invalid acquisition state. Must be one of: ${VALID_ACQUISITION_STATES.join(', ')}`
        );
        return true;
      }

      const playParam = query.get('playback') || 'all';
      if (!VALID_PLAYBACK_STATES.includes(playParam as any)) {
        sendError(
          res,
          400,
          `Invalid playback state. Must be one of: ${VALID_PLAYBACK_STATES.join(', ')}`
        );
        return true;
      }

      const typeParam = query.get('mediaType') || 'all';
      if (!VALID_MEDIA_TYPES.includes(typeParam as any)) {
        sendError(
          res,
          400,
          `Invalid mediaType. Must be one of: ${VALID_MEDIA_TYPES.join(', ')}`
        );
        return true;
      }

      const sortParam = query.get('sort') || 'updated_at';
      if (!VALID_SORT_FIELDS.includes(sortParam as any)) {
        sendError(
          res,
          400,
          `Invalid sort field. Must be one of: ${VALID_SORT_FIELDS.join(', ')}`
        );
        return true;
      }

      const orderParam = query.get('order') || 'desc';
      const order = orderParam.toLowerCase() === 'asc' ? 'asc' : 'desc';

      const pageRaw = query.get('page');
      let page = 1;
      if (pageRaw) {
        const parsed = parseInt(pageRaw, 10);
        if (isNaN(parsed) || parsed < 1) {
          sendError(res, 400, 'Page must be a positive integer');
          return true;
        }
        page = parsed;
      }

      const limitRaw = query.get('limit');
      let limit = 20;
      if (limitRaw) {
        const parsed = parseInt(limitRaw, 10);
        if (!isNaN(parsed)) {
          limit = Math.max(1, Math.min(parsed, 100));
        }
      }

      const result = getMyList(db, userId, {
        intent: intentParam as 'saved' | 'not_saved' | 'all',
        acquisition: acqParam as 'all' | AcquisitionState,
        playback: playParam as 'all' | PlaybackState,
        mediaType: typeParam as 'all' | 'movie' | 'series',
        sort: sortParam as any,
        order,
        page,
        limit,
      });

      sendJson(res, 200, result);
      return true;
    }

    // 7. GET /api/v1/my-list/:id
    const singleMatch = urlPath.match(SINGLE_MY_LIST_REGEX);
    if (req.method === 'GET' && singleMatch) {
      const idOrMediaId = singleMatch[1];
      const item = getMyListItem(db, userId, idOrMediaId);
      if (!item) {
        sendError(res, 404, 'Item not found in your list');
        return true;
      }

      sendJson(res, 200, item);
      return true;
    }

    return false;
  } catch (err: any) {
    console.error('Unhandled My List router error:', err);
    sendError(res, 500, 'Internal Server Error');
    return true;
  }
}
