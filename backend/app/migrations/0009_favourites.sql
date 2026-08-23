-- Favourites.
--
-- An album, not a flag on files. Everything albums already do — open it,
-- reorder it, set a cover, add all of it to another album, see it on the
-- Albums page with a count and a cover — is then true of Favourites for free,
-- and there is no second nearly-identical concept to keep in step.
--
-- What it does not share is ownership. `system` marks the rows the app created
-- and the user may not delete or rename: a heart that could stop existing is a
-- heart that stops meaning anything, and every photo in it would go with it.
-- The partial unique index is what keeps it to exactly one of each kind.
ALTER TABLE albums ADD COLUMN system TEXT;
CREATE UNIQUE INDEX idx_albums_system ON albums(system) WHERE system IS NOT NULL;

INSERT INTO albums (name, created_at, system)
VALUES ('Favourites', CAST(strftime('%s','now') AS INTEGER), 'favourites');
