-- Reads at the size of a real library.
--
-- Measured on a 300,000-file library before this migration: the timeline's
-- day list took 260 ms, People 620 ms, Places 730 ms, Events 470 ms, and the
-- library totals 200 ms plus a walk of every cached thumbnail — and every one
-- of those waited behind every other request on a single connection. None of
-- it was the web framework, which costs half a millisecond a call. All of it
-- was the shape of the queries: three NOT IN subqueries on every row, a
-- correlated subquery per person, per event and per city, and a GROUP BY over
-- the whole table for the one list every visit starts with.
--
-- Two changes. First, the facts those subqueries derived are stored on the row
-- they are about: is this file locked, is it a screenshot or a scan, is it the
-- still of a Live Photo, is it the movie half of one. The tables they came
-- from stay the source of truth; whatever writes them writes the flag in the
-- same transaction. Second, the aggregates every page opens with — days,
-- people counts, event counts, places, library totals — are kept in tables the
-- job runner refreshes when a job finishes, so opening a page reads a few rows
-- instead of recomputing the library. services/aggregates.py owns them.

ALTER TABLE files ADD COLUMN locked   INTEGER NOT NULL DEFAULT 0;  -- in the Locked section
ALTER TABLE files ADD COLUMN doc      INTEGER NOT NULL DEFAULT 0;  -- screenshot or scan (file_kinds, kind != 'photo')
ALTER TABLE files ADD COLUMN live     INTEGER NOT NULL DEFAULT 0;  -- a Live Photo's still
ALTER TABLE files ADD COLUMN livecomp INTEGER NOT NULL DEFAULT 0;  -- a Live Photo's movie half
UPDATE files SET locked = 1   WHERE id IN (SELECT file_id FROM locked_items);
UPDATE files SET doc = 1      WHERE id IN (SELECT file_id FROM file_kinds WHERE kind != 'photo');
UPDATE files SET live = 1     WHERE id IN (SELECT file_id FROM file_motion);
UPDATE files SET livecomp = 1 WHERE id IN (SELECT video_file_id FROM file_motion WHERE video_file_id IS NOT NULL);
-- The predicate every generated view starts with, answerable from one index —
-- and, with media_type and live on the end, the totals too, without touching
-- a row.
CREATE INDEX idx_files_browse ON files(status, locked, doc, livecomp, media_type, live);
CREATE INDEX idx_files_live ON files(status) WHERE live = 1;

-- The day a photo belongs to, stored once rather than sliced out of taken_at
-- on every row of every query. GROUP BY day now walks an index.
ALTER TABLE metadata ADD COLUMN day TEXT;
UPDATE metadata SET day = substr(taken_at, 1, 10) WHERE taken_at IS NOT NULL;
CREATE INDEX idx_meta_day ON metadata(day);

-- Counts that used to be a correlated subquery per row.
ALTER TABLE persons ADD COLUMN photo_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events  ADD COLUMN item_count  INTEGER NOT NULL DEFAULT 0;

-- The timeline's scroll skeleton, per scope the Photos page can show.
CREATE TABLE day_buckets (
  scope TEXT NOT NULL,        -- 'all' | 'photo' | 'video' | 'live'
  day   TEXT NOT NULL,
  n     INTEGER NOT NULL,
  ar    REAL NOT NULL,        -- summed width/height, for the grid's height estimate
  PRIMARY KEY (scope, day)
) WITHOUT ROWID;

-- Library totals: photos, videos, faces, cache sizes, and so on. Read by the
-- stats endpoint, the search status, and the Documents page's chips.
CREATE TABLE library_stats (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Places, grouped, with the newest visible photo as each group's cover.
CREATE TABLE place_summary (
  country TEXT NOT NULL,
  state   TEXT,
  city    TEXT,
  n       INTEGER NOT NULL,
  cover   INTEGER
);

-- The globe's pins at the precision the map asks for.
CREATE TABLE place_points (
  precision INTEGER NOT NULL,
  lat       REAL NOT NULL,
  lon       REAL NOT NULL,
  n         INTEGER NOT NULL,
  city      TEXT,
  country   TEXT
);

-- Planner statistics. Without them SQLite guessed that the new browse index
-- was the better way into a single day's photos and walked 300,000 files to
-- find twenty: 21 ms a section instead of none. db.close() keeps these fresh
-- with PRAGMA optimize.
ANALYZE;
