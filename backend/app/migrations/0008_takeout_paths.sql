-- Every path an import writes, with the archive entry it came from.
--
-- Extraction has always had a resume shortcut: a file already on disk at its
-- full size is left alone, so a 100 GB import that dies at 80% does not start
-- over. The shortcut assumed every such file was its own earlier output, and
-- nothing could tell it otherwise — so it adopted whatever was already in the
-- folder the user pointed at. A pre-existing photo smaller than the archived
-- one was overwritten outright; a larger one was kept but still had EXIF
-- spliced into it in place. Either way the user's own originals were destroyed
-- by an import that reported success.
--
-- This is the record that makes the question answerable. A path may be written
-- over only when this table says an earlier run put the very same archive entry
-- (crc + size) there; anything else on disk belongs to the user and the import
-- picks a different name instead.
CREATE TABLE takeout_paths (
  import_id INTEGER NOT NULL REFERENCES takeout_imports(id) ON DELETE CASCADE,
  rel_path  TEXT NOT NULL,     -- relative to takeout_imports.dest_path, POSIX
  crc       INTEGER NOT NULL,  -- zip entry CRC-32, identifying what was written
  size      INTEGER NOT NULL,
  PRIMARY KEY (import_id, rel_path)
);

-- Looked up by destination folder, once per import, before planning.
CREATE INDEX idx_takeout_paths_import ON takeout_paths(import_id);
