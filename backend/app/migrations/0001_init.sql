CREATE TABLE volumes (
  id INTEGER PRIMARY KEY,
  disk_uuid TEXT UNIQUE,
  label TEXT,
  last_mount_path TEXT,
  is_online INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE roots (
  id INTEGER PRIMARY KEY,
  volume_id INTEGER NOT NULL REFERENCES volumes(id),
  rel_path TEXT NOT NULL,
  UNIQUE(volume_id, rel_path)
);

CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  volume_id INTEGER NOT NULL REFERENCES volumes(id),
  rel_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('photo','video')),
  size_bytes INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  content_hash TEXT,
  phash INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','missing')),
  face_scanned INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL,
  UNIQUE(volume_id, rel_path)
);
CREATE INDEX idx_files_hash ON files(content_hash);
CREATE INDEX idx_files_faces ON files(face_scanned) WHERE face_scanned = 0;

CREATE TABLE metadata (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  taken_at TEXT,
  taken_at_ts INTEGER,
  taken_at_src TEXT,
  width INTEGER,
  height INTEGER,
  orientation INTEGER,
  camera_make TEXT,
  camera_model TEXT,
  iso INTEGER,
  f_number REAL,
  exposure TEXT,
  focal_length REAL,
  duration_s REAL,
  video_codec TEXT,
  gps_lat REAL,
  gps_lon REAL
);
CREATE INDEX idx_meta_taken ON metadata(taken_at DESC);
CREATE INDEX idx_meta_gps ON metadata(gps_lat) WHERE gps_lat IS NOT NULL;

CREATE TABLE file_places (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  country_code TEXT,
  country TEXT,
  state TEXT,
  city TEXT
);
CREATE INDEX idx_places_geo ON file_places(country, city);

CREATE TABLE persons (
  id INTEGER PRIMARY KEY,
  name TEXT,
  cover_face_id INTEGER,
  centroid BLOB,
  is_hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE faces (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  x REAL, y REAL, w REAL, h REAL,
  det_score REAL,
  embedding BLOB NOT NULL,
  person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
  assign_src TEXT
);
CREATE INDEX idx_faces_person ON faces(person_id);
CREATE INDEX idx_faces_file ON faces(file_id);

CREATE TABLE albums (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  cover_file_id INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE album_items (
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (album_id, file_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  title TEXT,
  is_user_titled INTEGER NOT NULL DEFAULT 0,
  start_ts INTEGER,
  end_ts INTEGER,
  cover_file_id INTEGER
);

CREATE TABLE event_items (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, file_id)
);

CREATE TABLE dupe_groups (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'near',
  created_at INTEGER NOT NULL
);

CREATE TABLE dupe_group_items (
  group_id INTEGER NOT NULL REFERENCES dupe_groups(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  is_suggested_keeper INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, file_id)
);

CREATE TABLE dupe_dismissals (
  file_id_a INTEGER NOT NULL,
  file_id_b INTEGER NOT NULL,
  PRIMARY KEY (file_id_a, file_id_b)
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  root_id INTEGER,
  status TEXT NOT NULL,
  total INTEGER DEFAULT 0,
  done INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  message TEXT,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
