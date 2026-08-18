-- Google Takeout imports.
--
-- Album membership is recorded while the archives are being extracted, but it
-- cannot be applied until afterwards: the files do not exist in `files` until
-- the scan that follows the import has run. Keeping it in a table rather than
-- in the job's memory means a crash between "extracted" and "indexed" costs
-- nothing — the albums are still there to apply on the next attempt.
CREATE TABLE takeout_imports (
  id           INTEGER PRIMARY KEY,
  dest_path    TEXT NOT NULL,        -- absolute path the media was written to
  archives     TEXT NOT NULL,        -- JSON array of the source .zip paths
  created_at   INTEGER NOT NULL,
  albums_applied INTEGER NOT NULL DEFAULT 0
);

-- One row per (album, photo). rel_path is relative to takeout_imports.dest_path
-- and POSIX-separated, matching how files.rel_path is stored.
CREATE TABLE takeout_album_items (
  import_id  INTEGER NOT NULL REFERENCES takeout_imports(id) ON DELETE CASCADE,
  album_name TEXT NOT NULL,
  rel_path   TEXT NOT NULL,
  PRIMARY KEY (import_id, album_name, rel_path)
);
