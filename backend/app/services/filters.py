"""Shared WHERE/JOIN builder so every grid (timeline, person, place, album,
event) is the same query with different filters."""


# kind='photo' rows are tombstones from a user correction ("not a document"),
# so they must read as ordinary photos — hence != 'photo', not merely EXISTS.
_NOT_PHOTO = "f.id IN (SELECT file_id FROM file_kinds WHERE kind != 'photo')"


# The movie half of a Live Photo is not a video anyone filmed — it is three
# seconds attached to a photograph. Counting it in Videos shows one moment
# twice and pads the tab with clips nobody shot.
_LIVE_COMPONENT = "f.id IN (SELECT video_file_id FROM file_motion WHERE video_file_id IS NOT NULL)"
_IS_LIVE = "f.id IN (SELECT file_id FROM file_motion)"


def build(person_id=None, country=None, city=None, album_id=None, event_id=None, day=None, solo=False,
          media_type=None, kind=None, live=False, state=None):
    joins = ["JOIN metadata m ON m.file_id = f.id"]
    # locked-section files are invisible to every grid
    where = ["f.status = 'active'", "m.taken_at IS NOT NULL",
             "f.id NOT IN (SELECT file_id FROM locked_items)"]
    params: list = []

    # Screenshots and scans are hidden from views the app generates, and kept
    # in views the user curated: putting a receipt in an album was deliberate,
    # and a face is a face whatever surface it was photographed on.
    curated = album_id is not None or person_id is not None or country is not None
    if kind == "any":
        where.append(_NOT_PHOTO)
    elif kind:
        where.append("f.id IN (SELECT file_id FROM file_kinds WHERE kind = ?)")
        params.append(kind)
    elif not curated:
        where.append(f"NOT ({_NOT_PHOTO})")
    if live:
        where.append(_IS_LIVE)
    if media_type in ("photo", "video"):
        where.append("f.media_type = ?")
        params.append(media_type)
        if media_type == "video":
            where.append(f"NOT ({_LIVE_COMPONENT})")
    elif not live:
        # "All" shows the photograph, not its motion clip as a second item.
        where.append(f"NOT ({_LIVE_COMPONENT})")
    if person_id is not None:
        joins.append("JOIN (SELECT DISTINCT file_id FROM faces WHERE person_id = ?) pf ON pf.file_id = f.id")
        params.append(person_id)
        if solo:
            # only this person: no face on the file assigned to anyone else
            # (unassigned faces are ignored — often tiny background detections)
            where.append(
                "NOT EXISTS (SELECT 1 FROM faces fo WHERE fo.file_id = f.id "
                "AND fo.person_id IS NOT NULL AND fo.person_id != ?)"
            )
            params.append(person_id)
    if country is not None:
        joins.append("JOIN file_places pl ON pl.file_id = f.id")
        where.append("pl.country = ?")
        params.append(country)
        # Narrowed independently: a state on its own is the Places page's own
        # sub-heading opening, and a state with a city is the same city as
        # before — two places of the same name in one country are then no
        # longer one grid.
        if state is not None:
            where.append("pl.state = ?")
            params.append(state)
        if city is not None:
            where.append("pl.city = ?")
            params.append(city)
    if album_id is not None:
        joins.append("JOIN album_items ai ON ai.file_id = f.id")
        where.append("ai.album_id = ?")
        params.append(album_id)
    if event_id is not None:
        joins.append("JOIN event_items ei ON ei.file_id = f.id")
        where.append("ei.event_id = ?")
        params.append(event_id)
    if day is not None:
        # A half-open range on the column itself, not substr() of it.
        #
        # The grid fetches one query per day section it scrolls into view, so
        # this is the single hottest query in the app — and substr() has to be
        # computed for every row in the library before it can be compared,
        # which ruled out idx_meta_taken and left a full scan as the only plan.
        # On a 400k-file library that was 112ms a section, ~1s for one scroll
        # burst, all of it holding the DB lock.
        #
        # taken_at is 'YYYY-MM-DD' followed by a separator and a time, so the
        # day is exactly the rows from the date up to the date + 'z': every
        # character a timestamp can continue with (' ', 'T', or nothing) sorts
        # below 'z', and the next day differs by then. Same rows, 9ms, and it
        # holds for a bare date with no time at all.
        where.append("m.taken_at >= ? AND m.taken_at < ?")
        params.extend([day, day + "z"])
    return " ".join(joins), " AND ".join(where), params
