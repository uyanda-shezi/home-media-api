export type MediaAcquisitionStatus =
  | 'not_requested'
  | 'pending'
  | 'processing'
  | 'partially_available'
  | 'available';

export type RequestStatus = 'pending' | 'approved' | 'declined' | 'available';

export type MediaType = 'movie' | 'tv';

export interface SeerrRequestUser {
  id: number;
  username?: string;
  jellyfinUserId?: string;
}

export interface SeerrRequestSummary {
  id: number;
  status: RequestStatus;
  requestedBy?: SeerrRequestUser;
  createdAt?: string;
  updatedAt?: string;
  seasons?: number[];
}

export interface SeerrMediaInfo {
  id?: number;
  tmdbId?: number;
  tvdbId?: number | null;
  status: MediaAcquisitionStatus;
  jellyfinMediaId?: string;
  requestId?: number;
  requests?: SeerrRequestSummary[];
}

export interface SeerrSearchResultItem {
  id: number;
  mediaType: MediaType;
  title: string;
  overview?: string;
  posterPath?: string;
  backdropPath?: string;
  releaseDate?: string;
  voteAverage?: number;
  mediaInfo?: SeerrMediaInfo;
}

export interface SeerrSearchResults {
  page: number;
  totalPages: number;
  totalResults: number;
  results: SeerrSearchResultItem[];
}

export interface SeerrMediaDetails {
  id: number;
  mediaType: MediaType;
  title: string;
  overview?: string;
  posterPath?: string;
  backdropPath?: string;
  releaseDate?: string;
  genres?: string[];
  voteAverage?: number;
  status?: string;
  mediaInfo?: SeerrMediaInfo;
}

export interface SeerrRequestMediaSummary {
  id?: number;
  tmdbId: number;
  tvdbId?: number | null;
  mediaType?: MediaType;
  title?: string;
  posterPath?: string;
  status?: MediaAcquisitionStatus;
}

export interface SeerrRequestItem {
  id: number;
  status: RequestStatus;
  mediaType: MediaType;
  media: SeerrRequestMediaSummary;
  requestedBy: SeerrRequestUser;
  seasons?: number[];
  createdAt: string;
  updatedAt?: string;
}

export interface SeerrRequestList {
  page: number;
  totalPages: number;
  totalResults: number;
  requests: SeerrRequestItem[];
}

export interface CreateRequestBody {
  mediaType: MediaType;
  mediaId: number;
  seasons?: number[] | 'all';
  is4k?: boolean;
}
