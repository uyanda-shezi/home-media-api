import type {
  JellyfinAvailabilityResult,
  JellyfinLibrary,
  JellyfinMediaItem,
  JellyfinMediaStream,
  JellyfinPaginatedItems,
  JellyfinPlaybackInfo,
  JellyfinSearchResults,
  JellyfinSeasonSummary,
  JellyfinTrackInfo,
} from './types.js';

export class JellyfinError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'JellyfinError';
  }
}

const DEFAULT_TIMEOUT_MS = 5000;

function getHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Emby-Token': token,
    'X-Emby-Authorization':
      'MediaBrowser Client="HomeMedia", Device="HomeMediaServer", DeviceId="home-media-api", Version="0.1.0"',
  };
}

/**
 * Strict field whitelisting to guarantee zero host path leaks (Path, MediaSources[].Path).
 */
export function sanitizeMediaItem(raw: any): JellyfinMediaItem {
  const providerIds: Record<string, string> = {};
  if (raw.ProviderIds && typeof raw.ProviderIds === 'object') {
    for (const [k, v] of Object.entries(raw.ProviderIds)) {
      if (typeof v === 'string') {
        providerIds[k] = v;
      }
    }
  }

  const mediaStreams: JellyfinMediaStream[] = [];
  if (Array.isArray(raw.MediaStreams)) {
    for (const s of raw.MediaStreams) {
      mediaStreams.push({
        type: s.Type || 'Unknown',
        codec: s.Codec,
        language: s.Language,
        title: s.Title || s.DisplayTitle,
        channels: typeof s.Channels === 'number' ? s.Channels : undefined,
        width: typeof s.Width === 'number' ? s.Width : undefined,
        height: typeof s.Height === 'number' ? s.Height : undefined,
        aspectRatio: s.AspectRatio,
        index: typeof s.Index === 'number' ? s.Index : undefined,
      });
    }
  }

  return {
    id: raw.Id,
    name: raw.Name || '',
    originalTitle: raw.OriginalTitle,
    type: raw.Type || 'Unknown',
    overview: raw.Overview,
    taglines: Array.isArray(raw.Taglines) ? raw.Taglines : undefined,
    genres: Array.isArray(raw.Genres) ? raw.Genres : undefined,
    communityRating: typeof raw.CommunityRating === 'number' ? raw.CommunityRating : undefined,
    officialRating: raw.OfficialRating,
    productionYear: typeof raw.ProductionYear === 'number' ? raw.ProductionYear : undefined,
    runTimeTicks: typeof raw.RunTimeTicks === 'number' ? raw.RunTimeTicks : undefined,
    primaryImageTag: raw.ImageTags?.Primary,
    backdropImageTag: Array.isArray(raw.BackdropImageTags) && raw.BackdropImageTags.length > 0
      ? raw.BackdropImageTags[0]
      : undefined,
    providerIds,
    userData: raw.UserData
      ? {
          played: Boolean(raw.UserData.Played),
          playbackPositionTicks: raw.UserData.PlaybackPositionTicks || 0,
          playCount: raw.UserData.PlayCount,
          isFavorite: Boolean(raw.UserData.IsFavorite),
          unplayedItemCount: raw.UserData.UnplayedItemCount,
        }
      : undefined,
    mediaStreams: mediaStreams.length > 0 ? mediaStreams : undefined,
  };
}

async function fetchJellyfinJson<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new JellyfinError(502, 'Upstream Jellyfin service is unreachable or timed out');
  }

  if (res.status === 401 || res.status === 403) {
    throw new JellyfinError(401, 'Jellyfin upstream authorization failed');
  }

  if (res.status === 404) {
    throw new JellyfinError(404, 'Requested Jellyfin item or library not found');
  }

  if (!res.ok) {
    throw new JellyfinError(502, `Upstream Jellyfin error: HTTP ${res.status}`);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new JellyfinError(502, 'Malformed JSON response from upstream Jellyfin');
  }
}

export async function getLibraries(
  jellyfinUrl: string,
  token: string,
  userId: string
): Promise<JellyfinLibrary[]> {
  const cleanUrl = jellyfinUrl.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/Users/${userId}/Views`;
  const data = await fetchJellyfinJson<{ Items?: any[] }>(endpoint, {
    headers: getHeaders(token),
  });

  const views = data.Items || [];
  return views.map((v) => ({
    id: v.Id,
    name: v.Name || '',
    collectionType: v.CollectionType || 'mixed',
    itemId: v.Id,
  }));
}

export interface LibraryItemsOptions {
  startIndex?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'Ascending' | 'Descending';
  itemTypes?: string;
}

export async function getLibraryItems(
  jellyfinUrl: string,
  token: string,
  userId: string,
  libraryId: string,
  options: LibraryItemsOptions = {}
): Promise<JellyfinPaginatedItems> {
  const cleanUrl = jellyfinUrl.replace(/\/+$/, '');
  const startIndex = options.startIndex && options.startIndex >= 0 ? options.startIndex : 0;
  const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 100) : 20;
  const sortBy = options.sortBy || 'SortName';
  const sortOrder = options.sortOrder || 'Ascending';
  const itemTypes = options.itemTypes || 'Movie,Series';

  const params = new URLSearchParams({
    ParentId: libraryId,
    StartIndex: String(startIndex),
    Limit: String(limit),
    SortBy: sortBy,
    SortOrder: sortOrder,
    Recursive: 'true',
    IncludeItemTypes: itemTypes,
    Fields: 'Overview,Genres,ProviderIds,UserData,MediaStreams,CommunityRating,OfficialRating,Taglines',
  });

  const endpoint = `${cleanUrl}/Users/${userId}/Items?${params.toString()}`;
  const data = await fetchJellyfinJson<{ TotalRecordCount?: number; Items?: any[] }>(endpoint, {
    headers: getHeaders(token),
  });

  const totalRecordCount = data.TotalRecordCount || 0;
  const rawItems = data.Items || [];
  return {
    totalRecordCount,
    startIndex,
    items: rawItems.map(sanitizeMediaItem),
  };
}

export interface SearchOptions {
  q: string;
  type?: 'movie' | 'series' | 'all';
  limit?: number;
}

export async function searchMedia(
  jellyfinUrl: string,
  token: string,
  userId: string,
  options: SearchOptions
): Promise<JellyfinSearchResults> {
  const cleanUrl = jellyfinUrl.replace(/\/+$/, '');
  const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 50) : 20;

  let includeTypes = 'Movie,Series';
  if (options.type === 'movie') includeTypes = 'Movie';
  if (options.type === 'series') includeTypes = 'Series';

  const params = new URLSearchParams({
    SearchTerm: options.q,
    IncludeItemTypes: includeTypes,
    Recursive: 'true',
    Limit: String(limit),
    Fields: 'Overview,Genres,ProviderIds,UserData,CommunityRating,OfficialRating',
  });

  const endpoint = `${cleanUrl}/Users/${userId}/Items?${params.toString()}`;
  const data = await fetchJellyfinJson<{ TotalRecordCount?: number; Items?: any[] }>(endpoint, {
    headers: getHeaders(token),
  });

  const totalRecordCount = data.TotalRecordCount || 0;
  const rawItems = data.Items || [];

  return {
    query: options.q,
    totalRecordCount,
    items: rawItems.map(sanitizeMediaItem),
  };
}

export async function getItemDetails(
  jellyfinUrl: string,
  token: string,
  userId: string,
  itemId: string,
  includeSeasons: boolean = false
): Promise<JellyfinMediaItem> {
  const cleanUrl = jellyfinUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({
    Fields: 'Overview,Genres,ProviderIds,UserData,MediaStreams,CommunityRating,OfficialRating,Taglines',
  });

  const endpoint = `${cleanUrl}/Users/${userId}/Items/${itemId}?${params.toString()}`;
  const raw = await fetchJellyfinJson<any>(endpoint, {
    headers: getHeaders(token),
  });

  const item = sanitizeMediaItem(raw);

  if (includeSeasons && item.type.toLowerCase() === 'series') {
    try {
      const seasonsEndpoint = `${cleanUrl}/Shows/${itemId}/Seasons?userId=${userId}&Fields=UserData`;
      const seasonsData = await fetchJellyfinJson<{ Items?: any[] }>(seasonsEndpoint, {
        headers: getHeaders(token),
      });

      const rawSeasons = seasonsData.Items || [];
      item.seasons = rawSeasons.map((s) => ({
        id: s.Id,
        name: s.Name || '',
        indexNumber: typeof s.IndexNumber === 'number' ? s.IndexNumber : undefined,
        episodeCount: typeof s.EpisodeCount === 'number' ? s.EpisodeCount : undefined,
        userData: s.UserData
          ? {
              played: Boolean(s.UserData.Played),
              playbackPositionTicks: s.UserData.PlaybackPositionTicks || 0,
              unplayedItemCount: s.UserData.UnplayedItemCount,
            }
          : undefined,
      }));
    } catch {
      // Non-fatal if seasons lookup fails; return base item
    }
  }

  return item;
}

export interface AvailabilityOptions {
  tmdbId?: string;
  tvdbId?: string;
  imdbId?: string;
  type?: 'movie' | 'series';
}

export async function checkAvailability(
  jellyfinUrl: string,
  token: string,
  userId: string,
  options: AvailabilityOptions
): Promise<JellyfinAvailabilityResult> {
  const cleanUrl = jellyfinUrl.replace(/\/+$/, '');

  let providerQuery = '';
  if (options.tmdbId) {
    providerQuery = `Tmdb.${options.tmdbId}`;
  } else if (options.tvdbId) {
    providerQuery = `Tvdb.${options.tvdbId}`;
  } else if (options.imdbId) {
    providerQuery = `Imdb.${options.imdbId}`;
  } else {
    throw new JellyfinError(400, 'At least one provider ID (tmdbId, tvdbId, or imdbId) is required');
  }

  let includeTypes = 'Movie,Series';
  if (options.type === 'movie') includeTypes = 'Movie';
  if (options.type === 'series') includeTypes = 'Series';

  const params = new URLSearchParams({
    AnyProviderIdEquals: providerQuery,
    IncludeItemTypes: includeTypes,
    Recursive: 'true',
    Limit: '1',
    Fields: 'ProviderIds,ProductionYear',
  });

  const endpoint = `${cleanUrl}/Users/${userId}/Items?${params.toString()}`;
  const data = await fetchJellyfinJson<{ Items?: any[] }>(endpoint, {
    headers: getHeaders(token),
  });

  const items = data.Items || [];
  if (items.length === 0) {
    return {
      available: false,
      jellyfinId: null,
    };
  }

  const found = items[0];
  const providerIds: Record<string, string> = {};
  if (found.ProviderIds && typeof found.ProviderIds === 'object') {
    for (const [k, v] of Object.entries(found.ProviderIds)) {
      if (typeof v === 'string') providerIds[k] = v;
    }
  }

  return {
    available: true,
    jellyfinId: found.Id,
    name: found.Name,
    type: found.Type,
    productionYear: found.ProductionYear,
    providerIds,
  };
}

export async function getPlaybackInfo(
  jellyfinUrl: string,
  jellyfinPublicUrl: string | undefined,
  token: string,
  userId: string,
  itemId: string
): Promise<JellyfinPlaybackInfo> {
  const cleanUrl = jellyfinUrl.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/Users/${userId}/Items/${itemId}?Fields=MediaStreams,UserData,RunTimeTicks`;
  const raw = await fetchJellyfinJson<any>(endpoint, {
    headers: getHeaders(token),
  });

  const baseUrl = (jellyfinPublicUrl || jellyfinUrl).replace(/\/+$/, '');
  const streamUrl = `${baseUrl}/Videos/${itemId}/stream?static=true&api_key=${token}`;
  const webDeepLink = `${baseUrl}/web/index.html#!/details?id=${itemId}`;
  const appDeepLink = `jellyfin://item?id=${itemId}`;

  const audioTracks: JellyfinTrackInfo[] = [];
  const subtitleTracks: JellyfinTrackInfo[] = [];

  if (Array.isArray(raw.MediaStreams)) {
    for (const s of raw.MediaStreams) {
      if (s.Type === 'Audio') {
        audioTracks.push({
          index: typeof s.Index === 'number' ? s.Index : 0,
          language: s.Language,
          codec: s.Codec,
          title: s.Title || s.DisplayTitle,
        });
      } else if (s.Type === 'Subtitle') {
        subtitleTracks.push({
          index: typeof s.Index === 'number' ? s.Index : 0,
          language: s.Language,
          codec: s.Codec,
          title: s.Title || s.DisplayTitle,
        });
      }
    }
  }

  return {
    itemId,
    name: raw.Name || '',
    runTimeTicks: typeof raw.RunTimeTicks === 'number' ? raw.RunTimeTicks : 0,
    playbackPositionTicks: raw.UserData?.PlaybackPositionTicks || 0,
    played: Boolean(raw.UserData?.Played),
    streamUrl,
    deepLinks: {
      web: webDeepLink,
      app: appDeepLink,
    },
    audioTracks,
    subtitleTracks,
  };
}

export async function reportPlaybackProgress(
  jellyfinUrl: string,
  token: string,
  itemId: string,
  positionTicks: number,
  isPaused: boolean = false,
  event: 'start' | 'progress' | 'stop' = 'progress'
): Promise<void> {
  const cleanUrl = jellyfinUrl.replace(/\/+$/, '');
  let endpoint = `${cleanUrl}/Sessions/Playing/Progress`;
  if (event === 'start') {
    endpoint = `${cleanUrl}/Sessions/Playing`;
  } else if (event === 'stop') {
    endpoint = `${cleanUrl}/Sessions/Playing/Stopped`;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...getHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ItemId: itemId,
      PositionTicks: positionTicks,
      IsPaused: isPaused,
      Event: event,
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (res.status === 401 || res.status === 403) {
    throw new JellyfinError(401, 'Jellyfin upstream authorization failed');
  }

  if (!res.ok) {
    throw new JellyfinError(502, `Failed to report playback progress to Jellyfin: HTTP ${res.status}`);
  }
}

export async function setPlayedStatus(
  jellyfinUrl: string,
  token: string,
  userId: string,
  itemId: string,
  played: boolean
): Promise<void> {
  const cleanUrl = jellyfinUrl.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/Users/${userId}/PlayedItems/${itemId}`;
  const method = played ? 'POST' : 'DELETE';

  const res = await fetch(endpoint, {
    method,
    headers: getHeaders(token),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (res.status === 401 || res.status === 403) {
    throw new JellyfinError(401, 'Jellyfin upstream authorization failed');
  }

  if (!res.ok) {
    throw new JellyfinError(502, `Failed to update played status in Jellyfin: HTTP ${res.status}`);
  }
}
