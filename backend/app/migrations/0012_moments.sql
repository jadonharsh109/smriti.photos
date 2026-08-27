-- Moments: a montage made from photographs the library already knows belong
-- together — an event, a person, a place, a date.
--
-- The row is the record, not the file. A rendered .mp4 is derived data like a
-- thumbnail: it can be deleted to reclaim the space and made again from the
-- same source, so `rel_path` is allowed to point at nothing and `status` says
-- which of "not yet", "being made" and "gone" is true.
--
-- `ref` is text rather than an id because the four kinds do not share an id
-- space: an event and a person are integers, a place is a city name and a day
-- is "MM-DD". A foreign key would only be right a quarter of the time.
CREATE TABLE moments (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  rel_path TEXT,
  duration_s REAL,
  bytes INTEGER,
  item_count INTEGER,
  cover_file_id INTEGER,
  track TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_moments_source ON moments(kind, ref);
