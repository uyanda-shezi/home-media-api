import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { readJellyfinSync, JellyfinError } from '../jellyfin/client.js';
import { readSeerrSync, SeerrError } from '../seerr/client.js';
import { findMediaItemById, jellyfinOwners, normalizeJellyfinId, positiveProviderId } from '../mylist/service.js';
import type { AcquisitionState, MediaItemRecord, PlaybackState } from '../mylist/types.js';

export type SyncSource = 'seerr' | 'jellyfin';

type Candidate = MediaItemRecord & { cursor: string };

interface PlaybackCandidate extends Candidate {
  user_id: string;
  jellyfin_user_id: string;
  role: string;
  session_id: string;
  jellyfin_access_token: string;
}

function isPlaybackCandidate(candidate: Candidate): candidate is PlaybackCandidate {
  return 'session_id' in candidate;
}

interface Pass {
  signal: AbortSignal;
  mayAdmit(): boolean;
  advance(cursor: string): void;
}

function withoutBusyWait<T>(db: Database.Database, work: () => T): T | undefined {
  const previous = db.pragma('busy_timeout', { simple: true }) as number;
  db.pragma('busy_timeout = 0');
  try {
    return work();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (!code || !/^SQLITE_(BUSY|LOCKED)(_|$)/.test(code)) throw error;
    return undefined;
  } finally {
    db.pragma(`busy_timeout = ${previous}`);
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function status(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max
    ? value : undefined;
}

function linkedState(media: number, request: number): AcquisitionState | undefined {
  if (media === 5) return 'available';
  if (media === 4) return 'partially_available';
  if (request === 3 || request === 4) return 'failed';
  if (media === 6) return undefined;
  if (media === 3 || request === 2) return 'processing';
  if (media === 2 || request === 1) return 'pending';
  if (request === 5 && media === 7) return 'not_requested';
}

async function observeSeerr(
  config: AppConfig, candidate: Candidate, tmdbId: number, pass: Pass
): Promise<AcquisitionState | undefined> {
  const type = candidate.media_type === 'series' ? 'tv' : 'movie';
  const requestId = positiveProviderId(candidate.seerr_request_id);
  if (requestId) {
    try {
      const request = object(await readSeerrSync(config.seerrUrl!, config.seerrApiKey!, 'request', requestId, pass.signal));
      const media = object(request?.media);
      if (request?.id !== requestId || media?.tmdbId !== tmdbId || media.mediaType !== type ||
          typeof request.is4k !== 'boolean') return;
      const mediaStatus = status(request.is4k ? media.status4k : media.status, 7);
      const requestStatus = status(request.status, 5);
      return mediaStatus && requestStatus ? linkedState(mediaStatus, requestStatus) : undefined;
    } catch (error) {
      if (!(error instanceof SeerrError && error.statusCode === 404)) throw error;
    }
  }

  if (!pass.mayAdmit()) return;
  const title = object(await readSeerrSync(config.seerrUrl!, config.seerrApiKey!, type, tmdbId, pass.signal));
  const info = object(title?.mediaInfo);
  if (title?.id !== tmdbId || (title.mediaType !== undefined && title.mediaType !== type) ||
      info?.tmdbId !== tmdbId || (info.mediaType !== undefined && info.mediaType !== type)) return;
  const normal = status(info.status, 7);
  const fourK = status(info.status4k, 7);
  if (!normal || (info.status4k !== undefined && !fourK)) return;
  const variants = [normal, fourK];
  if (variants.includes(5)) return 'available';
  if (variants.includes(4)) return 'partially_available';
  if (variants.includes(3)) return 'processing';
  if (variants.includes(2)) return 'pending';
  if (fourK && variants.includes(7) && variants.every(value => value === 1 || value === 7)) {
    return 'not_requested';
  }
}

function corroborates(item: Record<string, unknown>, candidate: Candidate): boolean {
  const providers = object(item.ProviderIds);
  return positiveProviderId(providers?.Tmdb) === candidate.tmdb_id &&
    item.Type === (candidate.media_type === 'movie' ? 'Movie' : 'Series') &&
    (candidate.tvdb_id === null || providers?.Tvdb === undefined ||
      positiveProviderId(providers.Tvdb) === candidate.tvdb_id) &&
    (candidate.imdb_id === null || providers?.Imdb === undefined || providers.Imdb === candidate.imdb_id);
}

function validateDiscovery(items: unknown[]): Record<string, unknown>[] | undefined {
  const seenIds = new Set<string>();
  const results: Record<string, unknown>[] = [];
  for (const value of items) {
    const item = object(value);
    if (!item || (item.Type !== 'Movie' && item.Type !== 'Series')) return;
    const id = normalizeJellyfinId(item.Id);
    if (!id || seenIds.has(id)) return;

    if (item.ProviderIds !== undefined) {
      const providers = object(item.ProviderIds);
      if (!providers) return;
      const { Tmdb, Tvdb, Imdb } = providers;
      if ((Tmdb !== undefined && !positiveProviderId(Tmdb)) ||
          (Tvdb !== undefined && !positiveProviderId(Tvdb)) ||
          (Imdb !== undefined && (typeof Imdb !== 'string' || !/^tt\d+$/.test(Imdb)))) return;
    }

    seenIds.add(id);
    results.push(item);
  }
  return results;
}

function projectPlayback(item: Record<string, unknown>) {
  const userData = object(item.UserData);
  const position = userData?.PlaybackPositionTicks;
  if (typeof userData?.Played !== 'boolean' || typeof position !== 'number' ||
      !Number.isSafeInteger(position) || position < 0) return;
  const playedAt = userData.LastPlayedDate;
  const timestamp = typeof playedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(playedAt)
    ? Date.parse(playedAt) : NaN;

  if (typeof playedAt === 'string' && Number.isFinite(timestamp)) {
    const calendarDate = playedAt.slice(0, 10);
    const midnight = new Date(calendarDate + 'T00:00:00Z');
    if (midnight.toISOString().slice(0, 10) !== calendarDate) return;
  } else if (playedAt != null) {
    return;
  }
  const runtime = typeof item.RunTimeTicks === 'number' ? positiveProviderId(item.RunTimeTicks) ?? null : null;
  const reported = item.PlayedPercentage;
  const percent = typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 && reported <= 100
    ? reported : runtime ? Math.min(100, position / runtime * 100) : 0;
  const state: PlaybackState = userData.Played ? 'watched'
    : position > 0 || percent > 0 ? 'in_progress' : 'unwatched';
  return {
    state, position, runtime, percent: userData.Played ? 100 : percent,
    playedAt: playedAt == null ? null : new Date(timestamp).toISOString(),
  };
}

const liveSession = "julianday(s.expires_at) > julianday('now')";

async function reconcilePlayback(
  db: Database.Database, config: AppConfig, candidate: PlaybackCandidate, pass: Pass
): Promise<false | void> {
  if (!pass.mayAdmit()) return false;
  pass.advance(candidate.cursor);

  const mapped = normalizeJellyfinId(candidate.jellyfin_item_id);
  if (candidate.jellyfin_item_id !== null) {
    if (!mapped || withoutBusyWait(db, () => jellyfinOwners(db, mapped).length) !== 1 ||
        !pass.mayAdmit()) return;
  }
  const type = candidate.media_type === 'movie' ? 'Movie' : 'Series';
  const response = object(await readJellyfinSync(config.jellyfinUrl!, candidate.jellyfin_access_token,
    candidate.jellyfin_user_id, mapped ? { id: mapped } : { title: candidate.title, type }, pass.signal));
  const items = response?.Items;
  if (!Array.isArray(items) || items.length > 25 ||
      (mapped ? items.length !== 1 : response?.TotalRecordCount !== items.length)) return;
  const results = mapped ? items.map(object) : validateDiscovery(items);
  if (!results) return;
  const matches = results.filter(item => item && corroborates(item, candidate));
  const match = matches[0];
  if (matches.length !== 1 || !match) return;
  const guid = normalizeJellyfinId(match.Id);
  if (!guid || (mapped && guid !== mapped)) return;
  const playback = projectPlayback(match);
  if (!playback || !pass.mayAdmit()) return;

  withoutBusyWait(db, db.transaction(() => {
    const live = db.prepare(`
      SELECT 1 FROM my_list ml JOIN users u ON ml.user_id = u.id
      JOIN sessions s ON s.user_id = u.id
      WHERE ml.id = ? AND ml.media_id = ? AND ml.user_id = ? AND u.jellyfin_user_id = ?
        AND u.role = ? AND s.id = ? AND s.jellyfin_access_token = ? AND ${liveSession}
    `).get(candidate.cursor, candidate.id, candidate.user_id, candidate.jellyfin_user_id,
      candidate.role, candidate.session_id, candidate.jellyfin_access_token);
    const current = findMediaItemById(db, candidate.id);
    if (!live || !current || current.media_type !== candidate.media_type ||
        current.tmdb_id !== candidate.tmdb_id || current.tvdb_id !== candidate.tvdb_id ||
        current.imdb_id !== candidate.imdb_id || current.jellyfin_item_id !== candidate.jellyfin_item_id) return;
    const owners = jellyfinOwners(db, guid);
    if (mapped ? owners.length !== 1 || owners[0].id !== current.id : owners.length > 0) return;
    if (!mapped) {
      db.prepare("UPDATE media_items SET jellyfin_item_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(guid, current.id);
    }
    db.prepare(`
      UPDATE my_list SET playback_state = @state, playback_position_ticks = @position,
        playback_runtime_ticks = @runtime, playback_percentage = @percent, last_played_at = @playedAt,
        updated_at = datetime('now')
      WHERE user_id = @user AND media_id = @media AND (playback_state IS NOT @state
        OR playback_position_ticks IS NOT @position OR playback_runtime_ticks IS NOT @runtime
        OR playback_percentage IS NOT @percent OR last_played_at IS NOT @playedAt)
    `).run({ ...playback, user: candidate.user_id, media: current.id });
  }).immediate);
}

function page(db: Database.Database, source: SyncSource, cursor: string) {
  const eligible = "m.media_type IN ('movie', 'series') AND typeof(m.tmdb_id) = 'integer' AND m.tmdb_id BETWEEN 1 AND 9007199254740991";
  if (source === 'seerr') {
    return db.prepare(`
      SELECT m.*, m.id AS cursor FROM media_items m
      WHERE m.id > ? AND ${eligible} AND EXISTS (SELECT 1 FROM my_list ml WHERE ml.media_id = m.id)
      ORDER BY m.id LIMIT 20
    `).all(cursor) as Candidate[];
  }
  return db.prepare(`
    SELECT m.*, ml.id AS cursor, u.id AS user_id, u.jellyfin_user_id, u.role,
      winner.id AS session_id, winner.jellyfin_access_token
    FROM my_list ml JOIN media_items m ON m.id = ml.media_id JOIN users u ON u.id = ml.user_id
    JOIN sessions winner ON winner.id = (
      SELECT s.id FROM sessions s WHERE s.user_id = u.id AND ${liveSession}
      ORDER BY julianday(s.created_at) DESC, s.id DESC LIMIT 1
    )
    WHERE ml.id > ? AND ${eligible} AND u.role IN ('standard', 'admin')
    ORDER BY ml.id LIMIT 20
  `).all(cursor) as PlaybackCandidate[];
}

export async function reconcilePass(
  db: Database.Database, config: AppConfig, source: SyncSource, cursor: string, pass: Pass
): Promise<void> {
  if (!pass.mayAdmit()) return;
  let candidates = withoutBusyWait(db, () => page(db, source, cursor));
  if (candidates?.length === 0 && cursor) {
    if (!pass.mayAdmit()) return;
    candidates = withoutBusyWait(db, () => page(db, source, ''));
  }
  if (!candidates) return;
  const rejected = new Set<string>();
  for (const candidate of candidates) {
    if (!pass.mayAdmit()) return;
    if (isPlaybackCandidate(candidate) && rejected.has(candidate.session_id)) {
      pass.advance(candidate.cursor);
      continue;
    }
    try {
      if (isPlaybackCandidate(candidate)) {
        const admitted = await reconcilePlayback(db, config, candidate, pass);
        if (admitted === false) return;
      } else {
        pass.advance(candidate.cursor);
        const state = await observeSeerr(config, candidate, candidate.tmdb_id!, pass);
        if (!state || !pass.mayAdmit()) continue;
        withoutBusyWait(db, db.transaction(() => {
          db.prepare(`
            UPDATE my_list SET acquisition_state = @state, updated_at = datetime('now')
            WHERE media_id = @id AND acquisition_state IS NOT @state AND EXISTS (
              SELECT 1 FROM media_items WHERE id = @id AND media_type = @type
                AND tmdb_id = @tmdb AND seerr_request_id IS @request
            )
          `).run({ state, id: candidate.id, type: candidate.media_type,
            tmdb: candidate.tmdb_id, request: candidate.seerr_request_id });
        }).immediate);
      }
    } catch (error) {
      if (!(error instanceof JellyfinError || error instanceof SeerrError)) throw error;
      const code = error.statusCode;
      if (code === 401 || code === 403) {
        if (!(isPlaybackCandidate(candidate))) throw error;
        rejected.add(candidate.session_id);
      } else if (code === 429 || code >= 500) {
        throw error;
      }
    }
  }
  if (candidates.length < 20) pass.advance('');
}
