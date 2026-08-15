-- Per-face quality signals for automatic cover selection.
-- landmarks: 5 (x,y) float32 pairs normalized 0..1 (left eye, right eye, nose,
--            left mouth corner, right mouth corner). NULL for faces detected
--            before this migration.
-- sharpness/brightness/contrast: measured on the aligned 112px face crop at
--            scan time (backfilled lazily from previews for older faces).
-- quality:   cached composite cover score, recomputed by cover selection.
ALTER TABLE faces ADD COLUMN landmarks BLOB;
ALTER TABLE faces ADD COLUMN sharpness REAL;
ALTER TABLE faces ADD COLUMN brightness REAL;
ALTER TABLE faces ADD COLUMN contrast REAL;
ALTER TABLE faces ADD COLUMN quality REAL;
