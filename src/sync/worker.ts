import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';

import { reconcilePass, type SyncSource } from './reconcile.js';

const cadence = 60_000;
const gap = 5_000;
const budget = 15_000;

interface SourceLoop {
  cursor: string;
  failures: number;
  finishedAt: number;
  due: number;
  timer?: ReturnType<typeof setTimeout>;
  active?: Promise<void>;
  hint: boolean;
}

export function createSyncWorker(db: Database.Database, config: AppConfig, now = () => performance.now()) {
  const stop = new AbortController();
  const loops = new Map<SyncSource, SourceLoop>();
  let stopped: Promise<void> | undefined;

  function schedule(source: SyncSource, loop: SourceLoop) {
    if (stop.signal.aborted) return;
    clearTimeout(loop.timer);
    const due = loop.hint && loop.failures === 0 ? Math.min(loop.due, loop.finishedAt + gap) : loop.due;
    loop.timer = setTimeout(() => {
      loop.timer = undefined;
      if (stop.signal.aborted) return;
      if (now() < due) {
        schedule(source, loop);
        return;
      }
      loop.hint = false;
      loop.active = run(source, loop).finally(() => {
        loop.active = undefined;
        schedule(source, loop);
      });
    }, Math.max(0, Math.ceil(due - now())));
    loop.timer.unref();
  }

  async function run(source: SyncSource, loop: SourceLoop) {
    const deadline = now() + budget;
    const expiration = new AbortController();
    const timer = setTimeout(() => expiration.abort(), budget);
    const signal = AbortSignal.any([stop.signal, expiration.signal]);
    try {
      await reconcilePass(db, config, source, loop.cursor, {
        signal,
        mayAdmit: () => !signal.aborted && now() < deadline,
        advance: cursor => { loop.cursor = cursor; },
      });
      if (!stop.signal.aborted) {
        loop.failures = 0;
        console.log(`Sync ${source}: completed`);
      }
    } catch {
      if (!stop.signal.aborted) {
        loop.failures = Math.min(loop.failures + 1, 4);
        console.warn(`Sync ${source}: backing off`);
      }
    } finally {
      clearTimeout(timer);
      loop.finishedAt = now();
      loop.due = loop.finishedAt + Math.min(300_000, cadence * 2 ** Math.max(0, loop.failures - 1));
    }
  }

  function start(source: SyncSource) {
    const loop: SourceLoop = { cursor: '', failures: 0, finishedAt: now(), due: now(), hint: false };
    loops.set(source, loop);
    schedule(source, loop);
  }

  if (config.syncEnabled === true) {
    if (config.seerrUrl && config.seerrApiKey) start('seerr');
    if (config.jellyfinUrl) start('jellyfin');
  }

  return {
    available(source: SyncSource) {
      return !stop.signal.aborted && loops.has(source);
    },
    accept(source: SyncSource) {
      const loop = loops.get(source);
      if (!loop || stop.signal.aborted) return false;
      loop.hint = true;
      if (!loop.active) schedule(source, loop);
      return true;
    },
    stop() {
      if (stopped) return stopped;
      stop.abort();
      for (const loop of loops.values()) clearTimeout(loop.timer);
      stopped = Promise.all([...loops.values()].map(loop => loop.active)).then(() => {});
      return stopped;
    },
  };
}

export type SyncWorker = ReturnType<typeof createSyncWorker>;
