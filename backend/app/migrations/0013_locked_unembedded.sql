-- Locked photos must not have search embeddings. v1.3.x embedded everything
-- active and filtered locked items only from the results — but an embedding
-- describes the photo: hand its id to "more like this" and the neighbours say
-- what it looks like, no passcode asked. Locking now deletes the embedding and
-- the indexer skips locked files; this cleans up any library indexed before
-- that was true. Unlocked photos count as pending and are re-embedded by the
-- next index run.
DELETE FROM file_clip WHERE file_id IN (SELECT file_id FROM locked_items);
