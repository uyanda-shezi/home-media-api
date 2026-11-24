ALTER TABLE my_list ADD COLUMN playback_runtime_ticks INTEGER
  CHECK (playback_runtime_ticks IS NULL OR playback_runtime_ticks > 0);

UPDATE system_metadata SET value = '4', updated_at = datetime('now')
WHERE key = 'schema_version';
