export type MediaType = 'movie' | 'series' | 'season' | 'episode';

export type UserIntent = 'saved' | 'not_saved';

export type AcquisitionState =
  | 'not_requested'
  | 'pending'
  | 'processing'
  | 'partially_available'
  | 'available'
  | 'failed';

export type PlaybackState = 'unwatched' | 'in_progress' | 'watched';

export interface MediaItemRecord {
  id: string;
  media_type: MediaType;
  tmdb_id: number | null;
  tvdb_id: number | null;
  imdb_id: string | null;
  jellyfin_item_id: string | null;
  seerr_request_id: number | null;
  parent_id: string | null;
  season_number: number | null;
  episode_number: number | null;
  title: string;
  original_title: string | null;
  release_date: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string | null;
  created_at: string;
  updated_at: string;
}

export interface MyListRecord {
  id: string;
  user_id: string;
  media_id: string;
  user_intent: UserIntent;
  acquisition_state: AcquisitionState;
  playback_state: PlaybackState;
  playback_position_ticks: number;
  playback_runtime_ticks: number | null;
  playback_percentage: number;
  last_played_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserPreferences {
  autoWatchlistRequests: boolean;
}

export interface MyListMediaView {
  id: string;
  mediaType: MediaType;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  jellyfinItemId: string | null;
  seerrRequestId: number | null;
  title: string;
  originalTitle: string | null;
  overview: string | null;
  releaseDate: string | null;
  posterPath: string | null;
  backdropPath: string | null;
}

export interface MyListItemView {
  id: string;
  mediaId: string;
  media: MyListMediaView;
  userIntent: UserIntent;
  acquisitionState: AcquisitionState;
  playbackState: PlaybackState;
  playback: {
    positionTicks: number;
    runtimeTicks: number | null;
    percentage: number;
    lastPlayedAt: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface MyListPaginatedResult {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  items: MyListItemView[];
}

export interface MyListFilterOptions {
  intent?: 'saved' | 'not_saved' | 'all';
  acquisition?: 'all' | AcquisitionState;
  playback?: 'all' | PlaybackState;
  mediaType?: 'all' | 'movie' | 'series';
  page?: number;
  limit?: number;
  sort?: 'updated_at' | 'created_at' | 'title' | 'last_played_at';
  order?: 'asc' | 'desc';
}

export interface UpsertMediaInput {
  mediaType: 'movie' | 'series';
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  jellyfinItemId?: string;
  seerrRequestId?: number;
  title: string;
  originalTitle?: string;
  releaseDate?: string;
  posterPath?: string;
  backdropPath?: string;
  overview?: string;
}
