export interface JellyfinLibrary {
  id: string;
  name: string;
  collectionType: string;
  itemId: string;
}

export interface JellyfinUserData {
  played: boolean;
  playbackPositionTicks: number;
  playCount?: number;
  isFavorite?: boolean;
  unplayedItemCount?: number;
}

export interface JellyfinMediaStream {
  type: string;
  codec?: string;
  language?: string;
  title?: string;
  channels?: number;
  width?: number;
  height?: number;
  aspectRatio?: string;
  index?: number;
}

export interface JellyfinSeasonSummary {
  id: string;
  name: string;
  indexNumber?: number;
  episodeCount?: number;
  userData?: JellyfinUserData;
}

export interface JellyfinMediaItem {
  id: string;
  name: string;
  originalTitle?: string;
  type: string;
  overview?: string;
  taglines?: string[];
  genres?: string[];
  communityRating?: number;
  officialRating?: string;
  productionYear?: number;
  runTimeTicks?: number;
  primaryImageTag?: string;
  backdropImageTag?: string;
  providerIds: Record<string, string>;
  userData?: JellyfinUserData;
  mediaStreams?: JellyfinMediaStream[];
  seasons?: JellyfinSeasonSummary[];
}

export interface JellyfinPaginatedItems {
  totalRecordCount: number;
  startIndex: number;
  items: JellyfinMediaItem[];
}

export interface JellyfinSearchResults {
  query: string;
  totalRecordCount: number;
  items: JellyfinMediaItem[];
}

export interface JellyfinAvailabilityResult {
  available: boolean;
  jellyfinId: string | null;
  name?: string;
  type?: string;
  productionYear?: number;
  providerIds?: Record<string, string>;
}

export interface JellyfinTrackInfo {
  index: number;
  language?: string;
  codec?: string;
  title?: string;
}

export interface JellyfinPlaybackInfo {
  itemId: string;
  name: string;
  runTimeTicks: number;
  playbackPositionTicks: number;
  played: boolean;
  streamUrl: string;
  deepLinks: {
    web: string;
    app: string;
  };
  audioTracks: JellyfinTrackInfo[];
  subtitleTracks: JellyfinTrackInfo[];
}
