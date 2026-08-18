-- Google Takeout imports.
--
-- An import only heals photos into a folder; whether that folder ever becomes
-- part of the library is the user's call, and may come days later or never.
-- So album membership is recorded here at extraction time and applied later,
-- if and when a scan gives those files ids. Keeping it in a table rather than
-- in the job's memory is what makes "later" possible at all.
CREATE TABLE takeout_imports (
  id           INTEGER PRIMARY KEY,
  dest_path    TEXT NOT NULL,        -- absolute path the media was written to
  archives     TEXT NOT NULL,        -- JSON array of the source .zip paths
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER,              -- NULL while running or if it was cancelled
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
