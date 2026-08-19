-- Live Photos: a still and a short movie that are one moment, not two.
--
-- Apple writes a shared UUID into both halves — `content.identifier` in the
-- movie's QuickTime tags, the same string inside the still's MakerNote — and
-- that, not the filename, is what makes a pair. Measured on a real library:
-- IMG_3570.HEIC and IMG_3570.MOV share a name while being a photo and an
-- unrelated 26-second video taken three weeks apart, so matching on names
-- would have merged them.
--
-- The identifier is stored on `metadata` because the video's half comes free:
-- ffprobe already runs on every video during a scan, and this is one more tag
-- off the output it already parses.
ALTER TABLE metadata ADD COLUMN content_id TEXT;
CREATE INDEX idx_metadata_content_id ON metadata(content_id) WHERE content_id IS NOT NULL;

-- One row per still that turned out to be a Live Photo.
CREATE TABLE file_motion (
  file_id       INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  -- The movie half, once it is indexed too. ON DELETE SET NULL rather than
  -- CASCADE: trashing the clip must not take the photograph with it.
  video_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  content_id    TEXT,
  source        TEXT NOT NULL      -- 'apple' | 'embedded'
);
CREATE INDEX idx_file_motion_video ON file_motion(video_file_id);
