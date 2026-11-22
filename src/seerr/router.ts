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
  approveRequest,
  declineRequest,
  deleteRequest,
  findSeerrUserByJellyfinId,
  getMediaDetails,
  getRequest,
  getTrending,
  listRequests,
  searchSeerr,
  SeerrError,
  submitRequest,
} from './client.js';
import { linkSeerrRequestAndWatchlist } from '../mylist/service.js';

const MEDIA_DETAILS_REGEX = /^\/api\/v1\/seerr\/media\/(movie|tv)\/(\d+)\/?$/;
const REQUEST_APPROVE_REGEX = /^\/api\/v1\/seerr\/requests\/(\d+)\/approve\/?$/;
const REQUEST_DECLINE_REGEX = /^\/api\/v1\/seerr\/requests\/(\d+)\/decline\/?$/;
const SINGLE_REQUEST_REGEX = /^\/api\/v1\/seerr\/requests\/(\d+)\/?$/;

function parseQuery(url: string | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) return new URLSearchParams();
  return new URLSearchParams(url.slice(queryIndex + 1));
}

export async function handleSeerrRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  config: AppConfig
): Promise<boolean> {
  const fullUrl = req.url || '';
  const urlPath = fullUrl.split('?')[0];

  if (!urlPath.startsWith('/api/v1/seerr')) {
    return false;
  }

  // 1. Missing Configuration Guard
  if (!config.seerrUrl || !config.seerrApiKey) {
    sendError(res, 503, 'Media requester (Seerr) unconfigured');
    return true;
  }

  // 2. Authentication Guard (all routes require authenticated session)
  const authCtx = requireAuth(req, res, db, config);
  if (!authCtx) return true;

  const query = parseQuery(fullUrl);

  try {
    // 3. GET /api/v1/seerr/search
    if (
      req.method === 'GET' &&
      (urlPath === '/api/v1/seerr/search' || urlPath === '/api/v1/seerr/search/')
    ) {
      const q = query.get('q')?.trim();
      if (!q) {
        sendError(res, 400, 'Search query is required');
        return true;
      }

      const typeParam = query.get('type') || 'all';
      if (typeParam !== 'movie' && typeParam !== 'tv' && typeParam !== 'all') {
        sendError(res, 400, "Invalid type. Must be 'movie', 'tv', or 'all'");
        return true;
      }

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

      const results = await searchSeerr(
        config.seerrUrl,
        config.seerrApiKey,
        q,
        typeParam as 'movie' | 'tv' | 'all',
        page
      );
      sendJson(res, 200, results);
      return true;
    }

    // 4. GET /api/v1/seerr/discover/trending
    if (
      req.method === 'GET' &&
      (urlPath === '/api/v1/seerr/discover/trending' ||
        urlPath === '/api/v1/seerr/discover/trending/')
    ) {
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

      const results = await getTrending(config.seerrUrl, config.seerrApiKey, page);
      sendJson(res, 200, results);
      return true;
    }

    // 5. GET /api/v1/seerr/media/:type/:id
    const mediaDetailsMatch = urlPath.match(MEDIA_DETAILS_REGEX);
    if (req.method === 'GET' && mediaDetailsMatch) {
      const mediaType = mediaDetailsMatch[1] as 'movie' | 'tv';
      const tmdbId = parseInt(mediaDetailsMatch[2], 10);

      const details = await getMediaDetails(
        config.seerrUrl,
        config.seerrApiKey,
        mediaType,
        tmdbId
      );
      sendJson(res, 200, details);
      return true;
    }

    // 6. POST /api/v1/seerr/requests/:id/approve (Admin Only)
    const approveMatch = urlPath.match(REQUEST_APPROVE_REGEX);
    if (req.method === 'POST' && approveMatch) {
      const adminCtx = requireMinimumRole(req, res, db, config, 'admin');
      if (!adminCtx) return true;

      const requestId = parseInt(approveMatch[1], 10);
      await approveRequest(config.seerrUrl, config.seerrApiKey, requestId);
      sendJson(res, 200, { id: requestId, status: 'approved' });
      return true;
    }

    // 7. POST /api/v1/seerr/requests/:id/decline (Admin Only)
    const declineMatch = urlPath.match(REQUEST_DECLINE_REGEX);
    if (req.method === 'POST' && declineMatch) {
      const adminCtx = requireMinimumRole(req, res, db, config, 'admin');
      if (!adminCtx) return true;

      const requestId = parseInt(declineMatch[1], 10);
      await declineRequest(config.seerrUrl, config.seerrApiKey, requestId);
      sendJson(res, 200, { id: requestId, status: 'declined' });
      return true;
    }

    // 8. GET or DELETE /api/v1/seerr/requests/:id
    const singleReqMatch = urlPath.match(SINGLE_REQUEST_REGEX);
    if (singleReqMatch) {
      const requestId = parseInt(singleReqMatch[1], 10);

      if (req.method === 'GET') {
        const item = await getRequest(config.seerrUrl, config.seerrApiKey, requestId);
        sendJson(res, 200, item);
        return true;
      }

      if (req.method === 'DELETE') {
        // Ownership verification for non-admins
        if (authCtx.user.role !== 'admin') {
          const existing = await getRequest(config.seerrUrl, config.seerrApiKey, requestId);
          const seerrUser = await findSeerrUserByJellyfinId(
            config.seerrUrl,
            config.seerrApiKey,
            authCtx.user.jellyfinUserId
          );

          const isOwner =
            (existing.requestedBy.jellyfinUserId &&
              existing.requestedBy.jellyfinUserId === authCtx.user.jellyfinUserId) ||
            (seerrUser && existing.requestedBy.id === seerrUser.id);

          if (!isOwner) {
            sendError(res, 403, 'You can only cancel your own requests');
            return true;
          }

          if (existing.status !== 'pending') {
            sendError(res, 403, 'Cannot cancel a request that has already been approved or processed');
            return true;
          }
        }

        await deleteRequest(config.seerrUrl, config.seerrApiKey, requestId);
        sendJson(res, 200, { status: 'deleted', requestId });
        return true;
      }
    }

    // 9. POST /api/v1/seerr/requests
    if (
      req.method === 'POST' &&
      (urlPath === '/api/v1/seerr/requests' || urlPath === '/api/v1/seerr/requests/')
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

      const mediaType = body.mediaType;
      if (mediaType !== 'movie' && mediaType !== 'tv') {
        sendError(res, 400, "mediaType must be 'movie' or 'tv'");
        return true;
      }

      const mediaId = body.mediaId;
      if (typeof mediaId !== 'number' || !Number.isInteger(mediaId) || mediaId <= 0) {
        sendError(res, 400, 'mediaId must be a positive integer');
        return true;
      }

      let seasons: number[] | 'all' | undefined = undefined;
      if (mediaType === 'tv') {
        if (body.seasons === 'all') {
          seasons = 'all';
        } else if (
          Array.isArray(body.seasons) &&
          body.seasons.length > 0 &&
          body.seasons.every((s: any) => typeof s === 'number' && Number.isInteger(s) && s >= 0)
        ) {
          seasons = body.seasons;
        } else {
          sendError(
            res,
            400,
            "For TV shows, 'seasons' must be an array of season numbers or 'all'"
          );
          return true;
        }
      }

      // Identity Binding: Resolve Seerr user by session's jellyfinUserId; ignore client userId
      const seerrUser = await findSeerrUserByJellyfinId(
        config.seerrUrl,
        config.seerrApiKey,
        authCtx.user.jellyfinUserId
      );

      const created = await submitRequest(config.seerrUrl, config.seerrApiKey, {
        mediaType,
        mediaId,
        seasons,
        is4k: Boolean(body.is4k),
        userId: seerrUser?.id,
      });

      // Hook: Automatic Watchlist registration (safely wrapped)
      try {
        linkSeerrRequestAndWatchlist(db, authCtx.user.id, {
          tmdbId: mediaId,
          mediaType: mediaType === 'tv' ? 'series' : 'movie',
          seerrRequestId: created.id,
          title: created.media?.title,
          posterPath: created.media?.posterPath,
        });
      } catch (hookErr) {
        console.error('Failed to link Seerr request to My List:', hookErr);
      }

      sendJson(res, 201, created);
      return true;
    }

    // 10. GET /api/v1/seerr/requests
    if (
      req.method === 'GET' &&
      (urlPath === '/api/v1/seerr/requests' || urlPath === '/api/v1/seerr/requests/')
    ) {
      const pageRaw = query.get('page');
      let page = 1;
      if (pageRaw) {
        const parsed = parseInt(pageRaw, 10);
        if (!isNaN(parsed) && parsed >= 1) {
          page = parsed;
        }
      }

      const limitRaw = query.get('limit');
      let limit = 20;
      if (limitRaw) {
        const parsed = parseInt(limitRaw, 10);
        if (!isNaN(parsed)) {
          limit = Math.max(1, Math.min(parsed, 50));
        }
      }

      const filter = query.get('filter') || undefined;
      const userFilter = query.get('user');

      let requestedByUserId: number | undefined = undefined;
      let requestedByJellyfinUserId: string | undefined = undefined;

      if (userFilter === 'me') {
        requestedByJellyfinUserId = authCtx.user.jellyfinUserId;
        const seerrUser = await findSeerrUserByJellyfinId(
          config.seerrUrl,
          config.seerrApiKey,
          authCtx.user.jellyfinUserId
        );
        requestedByUserId = seerrUser?.id;
      }

      const list = await listRequests(config.seerrUrl, config.seerrApiKey, {
        page,
        limit,
        filter,
        requestedByUserId,
        requestedByJellyfinUserId,
      });

      sendJson(res, 200, list);
      return true;
    }

    return false;
  } catch (err) {
    if (err instanceof SeerrError) {
      if (err.statusCode === 409) {
        sendJson(res, 409, {
          error: 'Media has already been requested or is already available',
          mediaId: err.details?.mediaId,
          status: 'pending',
        });
        return true;
      }
      sendError(res, err.statusCode, err.message);
      return true;
    }

    console.error('Unhandled Seerr router error:', err);
    sendError(res, 502, 'Upstream Seerr service is unreachable or timed out');
    return true;
  }
}
