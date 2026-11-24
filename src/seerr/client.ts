import type {
  CreateRequestBody,
  MediaAcquisitionStatus,
  MediaType,
  RequestStatus,
  SeerrMediaDetails,
  SeerrMediaInfo,
  SeerrRequestItem,
  SeerrRequestList,
  SeerrRequestSummary,
  SeerrRequestUser,
  SeerrSearchResultItem,
  SeerrSearchResults,
} from './types.js';

export class SeerrError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: any
  ) {
    super(message);
    this.name = 'SeerrError';
  }
}

const DEFAULT_TIMEOUT_MS = 5000;

export function sanitizeErrorMessage(err: unknown, apiKey?: string): string {
  let message = 'Unknown error';

  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.message.includes('timeout')) {
      return 'Request timed out after 5000ms';
    }

    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code) {
      if (cause.code === 'ECONNREFUSED') {
        return 'Connection refused (ECONNREFUSED)';
      }
      if (cause.code === 'ENOTFOUND') {
        return 'Host not found (ENOTFOUND)';
      }
      if (cause.code === 'ECONNRESET') {
        return 'Connection reset (ECONNRESET)';
      }
      return `Network error (${cause.code})`;
    }

    message = err.message;
  } else if (typeof err === 'string') {
    message = err;
  }

  if (apiKey && apiKey.length > 0 && message.includes(apiKey)) {
    message = message.replaceAll(apiKey, '[REDACTED]');
  }

  return message;
}

export function mapMediaStatus(code?: number): MediaAcquisitionStatus {
  switch (code) {
    case 2:
      return 'pending';
    case 3:
      return 'processing';
    case 4:
      return 'partially_available';
    case 5:
      return 'available';
    case 1:
    default:
      return 'not_requested';
  }
}

export function mapRequestStatus(code?: number | string): RequestStatus {
  if (typeof code === 'string') {
    const lower = code.toLowerCase();
    if (lower === 'approved') return 'approved';
    if (lower === 'declined') return 'declined';
    if (lower === 'available' || lower === 'completed') return 'available';
    return 'pending';
  }

  switch (code) {
    case 2:
      return 'approved';
    case 3:
      return 'declined';
    case 4:
    case 5:
      return 'available';
    case 1:
    default:
      return 'pending';
  }
}

function getHeaders(apiKey: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
  };
}

async function fetchSeerrJson<T>(
  url: string,
  apiKey: string,
  options: RequestInit = {},
  syncSignal?: AbortSignal
): Promise<T> {
  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const signal = syncSignal ? AbortSignal.any([syncSignal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        ...getHeaders(apiKey),
        ...(options.headers as Record<string, string> | undefined),
      },
      signal,
    });
  } catch (err) {
    throw new SeerrError(
      502,
      `Upstream Seerr service is unreachable or timed out: ${sanitizeErrorMessage(err, apiKey)}`
    );
  }

  if (syncSignal) {
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      throw new SeerrError(res.status, 'Upstream Seerr sync read failed');
    }
    try {
      return (await res.json()) as T;
    } catch (error) {
      const status = !signal.aborted && error instanceof SyntaxError ? 422 : 502;
      throw new SeerrError(status, 'Upstream Seerr sync response could not be read');
    }
  }

  if (res.status === 401 || res.status === 403) {
    throw new SeerrError(502, 'Seerr upstream authorization failed');
  }

  if (res.status === 404) {
    throw new SeerrError(404, 'Requested Seerr resource not found');
  }

  if (res.status === 409) {
    let details: any = null;
    try {
      details = await res.json();
    } catch {
      // ignore
    }
    throw new SeerrError(
      409,
      'Media has already been requested or is already available',
      details
    );
  }

  if (res.status === 400) {
    let details: any = null;
    try {
      details = await res.json();
    } catch {
      // ignore
    }
    const message = details?.message || details?.error || 'Bad request to upstream Seerr';
    throw new SeerrError(400, sanitizeErrorMessage(message, apiKey), details);
  }

  if (!res.ok) {
    throw new SeerrError(502, `Upstream Seerr error: HTTP ${res.status}`);
  }

  if (res.status === 204) {
    return null as unknown as T;
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new SeerrError(502, 'Malformed JSON response from upstream Seerr');
  }
}

export function sanitizeSeerrMediaInfo(rawMediaInfo: any): SeerrMediaInfo | undefined {
  if (!rawMediaInfo || typeof rawMediaInfo !== 'object') return undefined;

  const requests: SeerrRequestSummary[] = [];
  if (Array.isArray(rawMediaInfo.requests)) {
    for (const r of rawMediaInfo.requests) {
      requests.push({
        id: r.id,
        status: mapRequestStatus(r.status),
        requestedBy: r.requestedBy
          ? {
              id: r.requestedBy.id,
              username: r.requestedBy.username || r.requestedBy.email,
              jellyfinUserId: r.requestedBy.jellyfinUserId,
            }
          : undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        seasons: Array.isArray(r.seasons)
          ? r.seasons.map((s: any) => (typeof s === 'number' ? s : s.seasonNumber))
          : undefined,
      });
    }
  }

  return {
    id: rawMediaInfo.id,
    tmdbId: rawMediaInfo.tmdbId,
    tvdbId: rawMediaInfo.tvdbId ?? null,
    status: mapMediaStatus(rawMediaInfo.status),
    jellyfinMediaId: rawMediaInfo.jellyfinMediaId,
    requestId: requests.length > 0 ? requests[0].id : undefined,
    requests: requests.length > 0 ? requests : undefined,
  };
}

export function sanitizeRequestItem(raw: any): SeerrRequestItem {
  const media = raw.media || {};
  const requestedBy = raw.requestedBy || {};

  const seasons: number[] = [];
  if (Array.isArray(raw.seasons)) {
    for (const s of raw.seasons) {
      const num = typeof s === 'number' ? s : s?.seasonNumber;
      if (typeof num === 'number') {
        seasons.push(num);
      }
    }
  }

  return {
    id: raw.id,
    status: mapRequestStatus(raw.status),
    mediaType: (raw.type || media.mediaType || 'movie') as MediaType,
    media: {
      id: media.id,
      tmdbId: media.tmdbId ?? raw.mediaId ?? 0,
      tvdbId: media.tvdbId ?? null,
      mediaType: (media.mediaType || raw.type || 'movie') as MediaType,
      title: media.title || media.name || raw.title,
      posterPath: media.posterPath,
      status: mapMediaStatus(media.status),
    },
    requestedBy: {
      id: requestedBy.id ?? 0,
      username: requestedBy.username || requestedBy.email,
      jellyfinUserId: requestedBy.jellyfinUserId,
    },
    seasons: seasons.length > 0 ? seasons : undefined,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt,
  };
}

export async function findSeerrUserByJellyfinId(
  seerrUrl: string,
  apiKey: string,
  jellyfinUserId: string
): Promise<SeerrRequestUser | null> {
  const cleanUrl = seerrUrl.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/api/v1/user?take=100`;

  try {
    const data = await fetchSeerrJson<{ results?: any[] }>(endpoint, apiKey);
    const users = data.results || [];
    const found = users.find((u) => u.jellyfinUserId === jellyfinUserId);
    if (!found) return null;

    return {
      id: found.id,
      username: found.username || found.email,
      jellyfinUserId: found.jellyfinUserId,
    };
  } catch {
    // Non-fatal: if user list cannot be fetched, fall back gracefully
    return null;
  }
}

export async function searchSeerr(
  seerrUrl: string,
  apiKey: string,
  query: string,
  type: 'movie' | 'tv' | 'all' = 'all',
  page: number = 1
): Promise<SeerrSearchResults> {
  const cleanUrl = seerrUrl.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/api/v1/search?query=${encodeURIComponent(query)}&page=${page}`;

  const data = await fetchSeerrJson<{
    page?: number;
    totalPages?: number;
    totalResults?: number;
    results?: any[];
  }>(endpoint, apiKey);

  let rawResults = data.results || [];

  if (type !== 'all') {
    rawResults = rawResults.filter((r) => r.mediaType === type);
  } else {
    rawResults = rawResults.filter((r) => r.mediaType === 'movie' || r.mediaType === 'tv');
  }

  const results: SeerrSearchResultItem[] = rawResults.map((r) => ({
    id: r.id,
    mediaType: r.mediaType === 'tv' ? 'tv' : 'movie',
    title: r.title || r.name || '',
    overview: r.overview,
    posterPath: r.posterPath,
    backdropPath: r.backdropPath,
    releaseDate: r.releaseDate || r.firstAirDate,
    voteAverage: typeof r.voteAverage === 'number' ? r.voteAverage : undefined,
    mediaInfo: sanitizeSeerrMediaInfo(r.mediaInfo),
  }));

  return {
    page: data.page ?? page,
    totalPages: data.totalPages ?? 1,
    totalResults: data.totalResults ?? results.length,
    results,
  };
}

export async function getTrending(
  seerrUrl: string,
  apiKey: string,
  page: number = 1
): Promise<SeerrSearchResults> {
  const cleanUrl = seerrUrl.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/api/v1/discover/trending?page=${page}`;

  const data = await fetchSeerrJson<{
    page?: number;
    totalPages?: number;
    totalResults?: number;
    results?: any[];
  }>(endpoint, apiKey);

  const rawResults = (data.results || []).filter(
    (r) => r.mediaType === 'movie' || r.mediaType === 'tv'
  );

  const results: SeerrSearchResultItem[] = rawResults.map((r) => ({
    id: r.id,
    mediaType: r.mediaType === 'tv' ? 'tv' : 'movie',
    title: r.title || r.name || '',
    overview: r.overview,
    posterPath: r.posterPath,
    backdropPath: r.backdropPath,
    releaseDate: r.releaseDate || r.firstAirDate,
    voteAverage: typeof r.voteAverage === 'number' ? r.voteAverage : undefined,
    mediaInfo: sanitizeSeerrMediaInfo(r.mediaInfo),
  }));

  return {
    page: data.page ?? page,
    totalPages: data.totalPages ?? 1,
    totalResults: data.totalResults ?? results.length,
    results,
  };
}

export async function getMediaDetails(
  seerrUrl: string,
  apiKey: string,
  type: 'movie' | 'tv',
  tmdbId: number
): Promise<SeerrMediaDetails> {
  const cleanUrl = seerrUrl.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/api/v1/${type}/${tmdbId}`;

  const raw = await fetchSeerrJson<any>(endpoint, apiKey);

  const genres = Array.isArray(raw.genres)
    ? raw.genres.map((g: any) => (typeof g === 'string' ? g : g.name)).filter(Boolean)
    : undefined;

  return {
    id: raw.id,
    mediaType: type,
    title: raw.title || raw.name || '',
    overview: raw.overview,
    posterPath: raw.posterPath,
    backdropPath: raw.backdropPath,
    releaseDate: raw.releaseDate || raw.firstAirDate,
    genres: genres && genres.length > 0 ? genres : undefined,
    voteAverage: typeof raw.voteAverage === 'number' ? raw.voteAverage : undefined,
    status: raw.status,
    mediaInfo: sanitizeSeerrMediaInfo(raw.mediaInfo),
  };
}

export async function submitRequest(
  seerrUrl: string,
  apiKey: string,
  params: {
    mediaType: MediaType;
    mediaId: number;
    seasons?: number[] | 'all';
    is4k?: boolean;
    userId?: number;
  }
): Promise<SeerrRequestItem> {
  const cleanUrl = seerrUrl.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/api/v1/request`;

  const payload: Record<string, any> = {
    mediaType: params.mediaType,
    mediaId: params.mediaId,
    is4k: Boolean(params.is4k),
  };

  if (params.userId) {
    payload.userId = params.userId;
  }

  if (params.mediaType === 'tv') {
    payload.seasons = params.seasons;
  }

  const raw = await fetchSeerrJson<any>(endpoint, apiKey, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return sanitizeRequestItem(raw);
}

export interface ListRequestsOptions {
  page?: number;
  limit?: number;
  filter?: string;
  requestedByUserId?: number;
  requestedByJellyfinUserId?: string;
}

export async function listRequests(
  seerrUrl: string,
  apiKey: string,
  options: ListRequestsOptions = {}
): Promise<SeerrRequestList> {
  const cleanUrl = seerrUrl.replace(/\/+$/, '');
  const limit = Math.max(1, Math.min(options.limit || 20, 50));
  const page = Math.max(1, options.page || 1);
  const skip = (page - 1) * limit;

  let queryParams = `take=${limit}&skip=${skip}&sort=added`;
  if (options.filter && options.filter !== 'all') {
    queryParams += `&filter=${encodeURIComponent(options.filter)}`;
  }

  const endpoint = `${cleanUrl}/api/v1/request?${queryParams}`;

  const data = await fetchSeerrJson<{
    pageInfo?: { pages?: number; pageSize?: number; results?: number; page?: number };
    results?: any[];
  }>(endpoint, apiKey);

  let rawRequests = data.results || [];

  // Scoped filtering for current user
  if (options.requestedByUserId || options.requestedByJellyfinUserId) {
    rawRequests = rawRequests.filter((r) => {
      const u = r.requestedBy;
      if (!u) return false;
      if (options.requestedByUserId && u.id === options.requestedByUserId) return true;
      if (options.requestedByJellyfinUserId && u.jellyfinUserId === options.requestedByJellyfinUserId)
        return true;
      return false;
    });
  }

  const requests: SeerrRequestItem[] = rawRequests.map(sanitizeRequestItem);

  return {
    page,
    totalPages: (data.pageInfo?.pages ?? Math.ceil((data.pageInfo?.results ?? requests.length) / limit)) || 1,
    totalResults: data.pageInfo?.results ?? requests.length,
    requests,
  };
}

export async function getRequest(
  seerrUrl: string,
  apiKey: string,
  requestId: number
): Promise<SeerrRequestItem> {
  const cleanUrl = seerrUrl.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/api/v1/request/${requestId}`;

  const raw = await fetchSeerrJson<any>(endpoint, apiKey);
  return sanitizeRequestItem(raw);
}

export async function deleteRequest(
  seerrUrl: string,
  apiKey: string,
  requestId: number
): Promise<void> {
  const cleanUrl = seerrUrl.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/api/v1/request/${requestId}`;

  await fetchSeerrJson<void>(endpoint, apiKey, {
    method: 'DELETE',
  });
}

export async function approveRequest(
  seerrUrl: string,
  apiKey: string,
  requestId: number
): Promise<SeerrRequestItem> {
  const cleanUrl = seerrUrl.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/api/v1/request/${requestId}/approve`;

  const raw = await fetchSeerrJson<any>(endpoint, apiKey, {
    method: 'POST',
  });

  return sanitizeRequestItem(raw);
}

export async function declineRequest(
  seerrUrl: string,
  apiKey: string,
  requestId: number
): Promise<SeerrRequestItem> {
  const cleanUrl = seerrUrl.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/api/v1/request/${requestId}/decline`;

  const raw = await fetchSeerrJson<any>(endpoint, apiKey, {
    method: 'POST',
  });

  return sanitizeRequestItem(raw);
}

export function readSeerrSync(
  baseUrl: string,
  apiKey: string,
  resource: 'request' | 'movie' | 'tv',
  id: number,
  signal: AbortSignal
): Promise<unknown> {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/v1/${resource}/${encodeURIComponent(id)}`;
  return fetchSeerrJson(endpoint, apiKey, { redirect: 'error' }, signal);
}
