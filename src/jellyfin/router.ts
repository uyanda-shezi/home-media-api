import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import {
  readJsonBody,
  requireAuth,
  requireMinimumRole,
  sendError,
  sendJson,
} from '../auth/middleware.js';
import {
  checkAvailability,
  getItemDetails,
  getLibraries,
  getLibraryItems,
  getPlaybackInfo,
  JellyfinError,
  reportPlaybackProgress,
  searchMedia,
  setPlayedStatus,
} from './client.js';

const LIBRARY_ITEMS_REGEX = /^\/api\/v1\/jellyfin\/libraries\/([^/]+)\/items\/?$/;
const ITEM_PLAYBACK_REGEX = /^\/api\/v1\/jellyfin\/items\/([^/]+)\/playback\/?$/;
const ITEM_PROGRESS_REGEX = /^\/api\/v1\/jellyfin\/items\/([^/]+)\/progress\/?$/;
const ITEM_PLAYED_REGEX = /^\/api\/v1\/jellyfin\/items\/([^/]+)\/played\/?$/;
const ITEM_DETAILS_REGEX = /^\/api\/v1\/jellyfin\/items\/([^/]+)\/?$/;

function parseQuery(url: string | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) return new URLSearchParams();
  return new URLSearchParams(url.slice(queryIndex + 1));
}

export async function handleJellyfinRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  config: AppConfig
): Promise<boolean> {
  const fullUrl = req.url || '';
  const urlPath = fullUrl.split('?')[0];

  if (!urlPath.startsWith('/api/v1/jellyfin')) {
    return false;
  }

  if (!config.jellyfinUrl) {
    sendError(res, 502, 'Identity provider (Jellyfin) unconfigured');
    return true;
  }

  const query = parseQuery(fullUrl);

  try {
    // 1. GET /api/v1/jellyfin/libraries
    if (req.method === 'GET' && (urlPath === '/api/v1/jellyfin/libraries' || urlPath === '/api/v1/jellyfin/libraries/')) {
      const authCtx = requireMinimumRole(req, res, db, config, 'standard');
      if (!authCtx) return true;

      const libraries = await getLibraries(
        config.jellyfinUrl,
        authCtx.session.jellyfinAccessToken,
        authCtx.user.jellyfinUserId
      );

      sendJson(res, 200, { libraries });
      return true;
    }

    // 2. GET /api/v1/jellyfin/libraries/:id/items
    const libItemsMatch = urlPath.match(LIBRARY_ITEMS_REGEX);
    if (req.method === 'GET' && libItemsMatch) {
      const authCtx = requireMinimumRole(req, res, db, config, 'standard');
      if (!authCtx) return true;

      const libraryId = libItemsMatch[1];
      const startIndex = query.has('startIndex') ? parseInt(query.get('startIndex')!, 10) : undefined;
      const limit = query.has('limit') ? parseInt(query.get('limit')!, 10) : undefined;
      const sortBy = query.get('sortBy') || undefined;
      const sortOrderRaw = query.get('sortOrder');
      const sortOrder = sortOrderRaw === 'Descending' ? 'Descending' : 'Ascending';
      const itemTypes = query.get('itemTypes') || undefined;

      const result = await getLibraryItems(
        config.jellyfinUrl,
        authCtx.session.jellyfinAccessToken,
        authCtx.user.jellyfinUserId,
        libraryId,
        {
          startIndex: isNaN(startIndex || NaN) ? undefined : startIndex,
          limit: isNaN(limit || NaN) ? undefined : limit,
          sortBy,
          sortOrder,
          itemTypes,
        }
      );

      sendJson(res, 200, result);
      return true;
    }

    // 3. GET /api/v1/jellyfin/search
    if (req.method === 'GET' && (urlPath === '/api/v1/jellyfin/search' || urlPath === '/api/v1/jellyfin/search/')) {
      const authCtx = requireAuth(req, res, db, config);
      if (!authCtx) return true;

      const q = query.get('q')?.trim();
      if (!q || q.length === 0) {
        sendError(res, 400, 'Search query is required');
        return true;
      }

      const typeRaw = query.get('type') || 'all';
      if (!['movie', 'series', 'all'].includes(typeRaw)) {
        sendError(res, 400, "Invalid type parameter: must be 'movie', 'series', or 'all'");
        return true;
      }
      const type = typeRaw as 'movie' | 'series' | 'all';

      const limitRaw = query.get('limit');
      const limit = limitRaw ? parseInt(limitRaw, 10) : 20;

      const results = await searchMedia(
        config.jellyfinUrl,
        authCtx.session.jellyfinAccessToken,
        authCtx.user.jellyfinUserId,
        {
          q,
          type,
          limit: isNaN(limit) ? 20 : limit,
        }
      );

      sendJson(res, 200, results);
      return true;
    }

    // 4. GET /api/v1/jellyfin/availability
    if (req.method === 'GET' && (urlPath === '/api/v1/jellyfin/availability' || urlPath === '/api/v1/jellyfin/availability/')) {
      const authCtx = requireAuth(req, res, db, config);
      if (!authCtx) return true;

      const tmdbId = query.get('tmdbId') || undefined;
      const tvdbId = query.get('tvdbId') || undefined;
      const imdbId = query.get('imdbId') || undefined;
      const typeRaw = query.get('type');
      const type = typeRaw === 'movie' || typeRaw === 'series' ? typeRaw : undefined;

      if (!tmdbId && !tvdbId && !imdbId) {
        sendError(res, 400, 'At least one provider ID (tmdbId, tvdbId, or imdbId) is required');
        return true;
      }

      const result = await checkAvailability(
        config.jellyfinUrl,
        authCtx.session.jellyfinAccessToken,
        authCtx.user.jellyfinUserId,
        {
          tmdbId,
          tvdbId,
          imdbId,
          type,
        }
      );

      sendJson(res, 200, result);
      return true;
    }

    // 5. GET /api/v1/jellyfin/items/:id/playback
    const playbackMatch = urlPath.match(ITEM_PLAYBACK_REGEX);
    if (req.method === 'GET' && playbackMatch) {
      const authCtx = requireMinimumRole(req, res, db, config, 'standard');
      if (!authCtx) return true;

      const itemId = playbackMatch[1];
      const result = await getPlaybackInfo(
        config.jellyfinUrl,
        config.jellyfinPublicUrl,
        authCtx.session.jellyfinAccessToken,
        authCtx.user.jellyfinUserId,
        itemId
      );

      sendJson(res, 200, result);
      return true;
    }

    // 6. POST /api/v1/jellyfin/items/:id/progress
    const progressMatch = urlPath.match(ITEM_PROGRESS_REGEX);
    if (req.method === 'POST' && progressMatch) {
      const authCtx = requireMinimumRole(req, res, db, config, 'standard');
      if (!authCtx) return true;

      const itemId = progressMatch[1];
      const bodyResult = await readJsonBody<{
        positionTicks?: number;
        isPaused?: boolean;
        event?: string;
      }>(req);

      if (!bodyResult.ok) {
        sendError(res, bodyResult.status, bodyResult.error);
        return true;
      }

      const { positionTicks, isPaused, event: eventRaw } = bodyResult.data;
      if (typeof positionTicks !== 'number' || positionTicks < 0) {
        sendError(res, 400, 'positionTicks must be a non-negative number');
        return true;
      }

      let event: 'start' | 'progress' | 'stop' = 'progress';
      if (eventRaw === 'start' || eventRaw === 'progress' || eventRaw === 'stop') {
        event = eventRaw;
      }

      await reportPlaybackProgress(
        config.jellyfinUrl,
        authCtx.session.jellyfinAccessToken,
        itemId,
        positionTicks,
        Boolean(isPaused),
        event
      );

      sendJson(res, 200, {
        status: 'ok',
        itemId,
        positionTicks,
      });
      return true;
    }

    // 7. POST /api/v1/jellyfin/items/:id/played
    const playedMatch = urlPath.match(ITEM_PLAYED_REGEX);
    if (req.method === 'POST' && playedMatch) {
      const authCtx = requireMinimumRole(req, res, db, config, 'standard');
      if (!authCtx) return true;

      const itemId = playedMatch[1];
      const bodyResult = await readJsonBody<{ played?: boolean }>(req);

      let played = true;
      if (bodyResult.ok && typeof bodyResult.data.played === 'boolean') {
        played = bodyResult.data.played;
      }

      await setPlayedStatus(
        config.jellyfinUrl,
        authCtx.session.jellyfinAccessToken,
        authCtx.user.jellyfinUserId,
        itemId,
        played
      );

      sendJson(res, 200, {
        status: 'ok',
        itemId,
        played,
      });
      return true;
    }

    // 8. GET /api/v1/jellyfin/items/:id
    const itemMatch = urlPath.match(ITEM_DETAILS_REGEX);
    if (req.method === 'GET' && itemMatch) {
      const authCtx = requireMinimumRole(req, res, db, config, 'standard');
      if (!authCtx) return true;

      const itemId = itemMatch[1];
      const includeSeasons = query.get('includeSeasons') === 'true';

      const item = await getItemDetails(
        config.jellyfinUrl,
        authCtx.session.jellyfinAccessToken,
        authCtx.user.jellyfinUserId,
        itemId,
        includeSeasons
      );

      sendJson(res, 200, item);
      return true;
    }
  } catch (err) {
    if (err instanceof JellyfinError) {
      sendError(res, err.statusCode, err.message);
      return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 502, `Jellyfin integration error: ${message}`);
    return true;
  }

  return false;
}
