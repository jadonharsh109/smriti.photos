-- What a file actually is, beyond photo/video: screenshots, scanned documents.
-- Deliberately its own table rather than a column on files, so reclassifying
-- is a DELETE + INSERT that never touches the file rows, and so a future
-- model pass can rewrite verdicts without migrating anything.
CREATE TABLE file_kinds (
  file_id    INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,      -- 'screenshot' | 'document'
  confidence REAL NOT NULL,
  source     TEXT NOT NULL       -- 'heuristic' | 'model' | 'manual'
);

-- Only non-photo rows are stored, so this index covers every lookup the
-- timeline makes ("is this file a document?").
CREATE INDEX idx_file_kinds_kind ON file_kinds(kind);

-- A user's correction outlives every reclassification pass, the same way
-- faces.assign_src = 'manual' survives re-clustering.
CREATE INDEX idx_file_kinds_manual ON file_kinds(source) WHERE source = 'manual';
