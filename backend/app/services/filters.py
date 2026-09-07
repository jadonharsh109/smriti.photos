"""Shared WHERE/JOIN builder so every grid (timeline, person, place, album,
event) is the same query with different filters.

The visibility facts — locked, screenshot-or-scan, Live Photo still, Live
Photo movie half — are flags on `files` (migration 0014), written by the code
that changes them. They used to be three NOT IN subqueries per query, which
at 300,000 files was most of the cost of every page. See services/aggregates.
"""


def build(person_id=None, country=None, city=None, album_id=None, event_id=None, day=None, solo=False,
          media_type=None, kind=None, live=False, state=None,
          since=None, until=None, month=None, curated=False, person_ids=None):
    joins = ["JOIN metadata m ON m.file_id = f.id"]
    # locked-section files are invisible to every grid
    where = ["f.status = 'active'", "f.locked = 0", "m.taken_at IS NOT NULL"]
    # Two lists, joined at the end, because SQLite binds ? by position in the
    # finished SQL — and every JOIN is rendered before the WHERE. One flat list
    # appended to in clause order therefore bound them crossways the moment a
    # person filter (whose ? lives in a JOIN) met a kind or media_type one
    # (whose ? lives in the WHERE): person_id='screenshot', kind=103, and a
    # confident empty grid. Unreachable while browsing — no page combines them
    # — and reachable the day search did.
    jparams: list = []
    wparams: list = []

    # Screenshots and scans are hidden from views the app generates, and kept
    # in views the user curated: putting a receipt in an album was deliberate,
    # and a face is a face whatever surface it was photographed on.
    # `curated` is also passed in by search: asking for something by name is as
    # deliberate as opening an album, so a search for "invoice" must be allowed
    # to find the receipt that every generated view deliberately hides.
    curated = curated or album_id is not None or person_id is not None or country is not None
    if kind == "any":
        where.append("f.doc = 1")
    elif kind:
        where.append("f.id IN (SELECT file_id FROM file_kinds WHERE kind = ?)")
        wparams.append(kind)
    elif not curated:
        where.append("f.doc = 0")
    if live:
        where.append("f.live = 1")
    if media_type in ("photo", "video"):
        where.append("f.media_type = ?")
        wparams.append(media_type)
        if media_type == "video":
            # The movie half of a Live Photo is not a video anyone filmed.
            where.append("f.livecomp = 0")
    elif not live:
        # "All" shows the photograph, not its motion clip as a second item.
        where.append("f.livecomp = 0")
    # One person or several, and several means all of them in the same photo —
    # one JOIN each, so the joins intersect. "yash and karan" is a photo with
    # both in it, which is the only reading of it anyone means.
    people = list(person_ids) if person_ids else ([person_id] if person_id is not None else [])
    for n, pid in enumerate(people):
        joins.append(f"JOIN (SELECT DISTINCT file_id FROM faces WHERE person_id = ?) pf{n} "
                     f"ON pf{n}.file_id = f.id")
        jparams.append(pid)
    if solo and people:
        # No face on the file assigned to anyone outside the set. With one
        # person that is "solo"; with several it is "these and nobody else",
        # which is the same sentence and the same clause.
        # (Unassigned faces are ignored — often tiny background detections.)
        where.append(
            "NOT EXISTS (SELECT 1 FROM faces fo WHERE fo.file_id = f.id "
            f"AND fo.person_id IS NOT NULL AND fo.person_id NOT IN ({','.join('?' * len(people))}))")
        wparams.extend(people)
    if country is not None or state is not None or city is not None:
        joins.append("JOIN file_places pl ON pl.file_id = f.id")
        # Each narrows independently, and each is optional. Browsing always
        # arrives here with a country — Places drills country, then state, then
        # city — and for those callers this is the same query it always was.
        # Search does not: "photos in Indore" names a city and no country.
        if country is not None:
            where.append("pl.country = ?")
            wparams.append(country)
        if state is not None:
            where.append("pl.state = ?")
            wparams.append(state)
        if city is not None:
            where.append("pl.city = ?")
            wparams.append(city)
    if album_id is not None:
        joins.append("JOIN album_items ai ON ai.file_id = f.id")
        where.append("ai.album_id = ?")
        wparams.append(album_id)
    if event_id is not None:
        joins.append("JOIN event_items ei ON ei.file_id = f.id")
        where.append("ei.event_id = ?")
        wparams.append(event_id)
    if day is not None:
        # The stored day column, indexed. This is the single hottest query in
        # the app — one per day section scrolled into view.
        where.append("m.day = ?")
        wparams.append(day)
    # A half-open range compared against the column itself so idx_meta_taken
    # can still be used. "in 2024" and "March 2024" are both just a range.
    if since is not None:
        where.append("m.taken_at >= ?")
        wparams.append(since)
    if until is not None:
        where.append("m.taken_at < ?")
        wparams.append(until)
    if month is not None:
        # A month with no year — "photos in December" means every December.
        # No index can serve this one; it is a search-only filter and rare
        # enough that a scan of the dated rows is the honest price.
        where.append("CAST(strftime('%m', m.taken_at) AS INTEGER) = ?")
        wparams.append(int(month))
    return " ".join(joins), " AND ".join(where), jparams + wparams


def is_plain(person_id=None, country=None, city=None, album_id=None, event_id=None, solo=False,
             kind=None, state=None, person_ids=None) -> bool:
    """True when the only filters are media_type / live — the scopes
    `day_buckets` keeps precomputed."""
    return (person_id is None and country is None and city is None and state is None
            and album_id is None and event_id is None and not solo and not kind and not person_ids)
