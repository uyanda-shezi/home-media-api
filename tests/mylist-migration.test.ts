import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { upsertUserAndCreateSession } from '../src/users/service.js';

describe('Media Identity & My List Migrations', () => {
  const testDir = join(process.cwd(), 'tmp-test-mylist-migration');
  const dbPath = join(testDir, 'migration.db');

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('applies 0003_media_and_my_list.sql cleanly and enforces constraints and foreign keys', () => {
    const db = createDb(dbPath);

    // 1. Run migrations and verify 0003 is applied
    const result = runMigrations(db, './migrations');
    assert.ok(result.applied.includes('0003_media_and_my_list.sql'));

    // Verify system_metadata schema_version is 3
    const versionRow = db
      .prepare(`SELECT value FROM system_metadata WHERE key = 'schema_version'`)
      .get() as { value: string };
    assert.strictEqual(versionRow.value, '3');

    // 2. Insert test user
    const userCtx = upsertUserAndCreateSession(db, {
      userId: 'jf-user-1',
      username: 'Alice',
      isAdministrator: true,
      accessToken: 'token-alice',
    });
    const userId = userCtx.user.id;

    // 3. Test media_items table and unique partial index
    const mediaId = randomUUID();
    db.prepare(
      `INSERT INTO media_items (id, media_type, tmdb_id, title)
       VALUES (?, 'movie', 550, 'Fight Club')`
    ).run(mediaId);

    // Attempting to insert duplicate (media_type, tmdb_id) must throw SQLite constraint error
    assert.throws(() => {
      db.prepare(
        `INSERT INTO media_items (id, media_type, tmdb_id, title)
         VALUES (?, 'movie', 550, 'Fight Club Duplicate')`
      ).run(randomUUID());
    }, /UNIQUE constraint failed/);

    // Different media_type with same tmdb_id is allowed (movie 550 vs series 550)
    const seriesId = randomUUID();
    db.prepare(
      `INSERT INTO media_items (id, media_type, tmdb_id, title)
       VALUES (?, 'series', 550, 'Fight Club Series')`
    ).run(seriesId);

    // 4. Test user_preferences table
    db.prepare(
      `INSERT INTO user_preferences (user_id, auto_watchlist_requests)
       VALUES (?, 1)`
    ).run(userId);

    // 5. Test my_list table and unique(user_id, media_id)
    const myListId = randomUUID();
    db.prepare(
      `INSERT INTO my_list (id, user_id, media_id, user_intent, acquisition_state, playback_state)
       VALUES (?, ?, ?, 'saved', 'available', 'unwatched')`
    ).run(myListId, userId, mediaId);

    // Attempt duplicate for same user and media_id must throw
    assert.throws(() => {
      db.prepare(
        `INSERT INTO my_list (id, user_id, media_id, user_intent)
         VALUES (?, ?, ?, 'saved')`
      ).run(randomUUID(), userId, mediaId);
    }, /UNIQUE constraint failed/);

    // 6. Test foreign key CASCADE on user deletion
    db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);

    const prefCount = db
      .prepare(`SELECT COUNT(*) as count FROM user_preferences WHERE user_id = ?`)
      .get(userId) as { count: number };
    assert.strictEqual(prefCount.count, 0);

    const listCount = db
      .prepare(`SELECT COUNT(*) as count FROM my_list WHERE user_id = ?`)
      .get(userId) as { count: number };
    assert.strictEqual(listCount.count, 0);

    // Media item itself must NOT be deleted when a user is deleted
    const mediaExists = db
      .prepare(`SELECT COUNT(*) as count FROM media_items WHERE id = ?`)
      .get(mediaId) as { count: number };
    assert.strictEqual(mediaExists.count, 1);

    db.close();
  });
});
