-- Sharpness, so Cleanup can offer up the blurry shots worth deleting.
--
-- Measured from the 512px thumbnail rather than the original: the thumbnails
-- already exist for every indexed photo, so this works on a library that is
-- already built, with no re-index and no second full read of every file.
--
-- `sharpness` is the variance of the Laplacian — a relative number, not an
-- absolute one. It shifts with resolution, subject and JPEG quality, which is
-- why the UI offers a sensitivity rather than pretending one threshold is
-- universally right.
CREATE TABLE file_quality (
  file_id   INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  sharpness REAL NOT NULL,
  source    TEXT NOT NULL,      -- 'thumb'  (room for 'full' later)
  scored_at INTEGER NOT NULL
);
CREATE INDEX idx_file_quality_sharpness ON file_quality(sharpness);
