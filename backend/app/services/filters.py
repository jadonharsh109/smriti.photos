"""Shared WHERE/JOIN builder so every grid (timeline, person, place, album,
event) is the same query with different filters."""


def build(person_id=None, country=None, city=None, album_id=None, event_id=None, day=None, solo=False,
          media_type=None):
    joins = ["JOIN metadata m ON m.file_id = f.id"]
    # locked-section files are invisible to every grid
    where = ["f.status = 'active'", "m.taken_at IS NOT NULL",
             "f.id NOT IN (SELECT file_id FROM locked_items)"]
    params: list = []
    if media_type in ("photo", "video"):
        where.append("f.media_type = ?")
        params.append(media_type)
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
        where.append("substr(m.taken_at, 1, 10) = ?")
        params.append(day)
    return " ".join(joins), " AND ".join(where), params
