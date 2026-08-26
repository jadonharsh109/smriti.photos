-- Semantic search: one embedding per photo, in CLIP's joint image/text space.
--
-- A separate table rather than a column on `files`, and a `model` beside every
-- vector rather than an assumption. Embeddings from two different models are
-- not comparable — a query encoded by one and an image by another produces
-- numbers, ranks them confidently, and is wrong in a way nothing reports. The
-- model name is the guard: change it and the old rows stop matching the query
-- for what needs re-encoding, which re-encodes them.
CREATE TABLE file_clip (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  embedding BLOB NOT NULL
);
CREATE INDEX idx_file_clip_model ON file_clip(model);
