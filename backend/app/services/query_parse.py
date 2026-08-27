"""Reading a search query for the parts the library already knows exactly.

"solo photos of yash in goa last march" is three questions in one sentence, and
only one of them is a question about what a picture looks like. Smriti knows
who Yash is — a face cluster someone named — and knows which photos carry Goa's
coordinates, and knows what March means. Those are lookups, not guesses, and
handing them to a model that has never seen a name gets them wrong: CLIP scores
"yash" against pixels and returns strangers.

So the sentence is split. Names, places, dates and a handful of plain modifiers
are matched against the index and become filters; whatever words are left over
are what the query is actually *about*, and only those go to the model.

Matching is longest-phrase-first, because names and places are frequently two
words ("Arjun Chacha", "Madhya Pradesh") and matching "arjun" alone would strand
"chacha" in the semantic half, where it would quietly skew the ranking.
"""
import re
import threading
from dataclasses import dataclass, field

from . import favourites
from .. import db

# Words that carry no filter and mean nothing to the model either. "photos" is
# here because it is how people say "items", not because it means media_type —
# "photos of yash" wants his videos too. "videos" deliberately is *not* here.
_STOP = {
    "a", "an", "the", "of", "in", "at", "on", "with", "from", "and", "to", "for",
    "my", "me", "mine", "our", "i", "we", "us", "is", "are", "was", "were",
    "photo", "photos", "pic", "pics", "picture", "pictures", "image", "images",
    "shot", "shots", "taken", "show", "find", "search", "all", "any", "some",
}

_MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"], start=1)}
_MONTHS.update({m[:3]: i for m, i in list(_MONTHS.items())})
_MONTHS["sept"] = 9

# phrase -> (field, value, label). Multi-word entries are matched as phrases.
_MODIFIERS: dict[str, tuple[str, object, str]] = {
    # "only" and "just" are the same word as "solo" once there is a set of
    # people to be exclusive about: one person and it means alone, several and
    # it means these and nobody else.
    "solo": ("solo", True, "Solo"),
    "alone": ("solo", True, "Solo"),
    "only": ("solo", True, "Solo"),
    "just": ("solo", True, "Solo"),
    "nobody else": ("solo", True, "Solo"),
    "no one else": ("solo", True, "Solo"),
    "by himself": ("solo", True, "Solo"),
    "by herself": ("solo", True, "Solo"),
    "by themselves": ("solo", True, "Solo"),
    "video": ("media_type", "video", "Videos"),
    "videos": ("media_type", "video", "Videos"),
    "clip": ("media_type", "video", "Videos"),
    "clips": ("media_type", "video", "Videos"),
    "screenshot": ("kind", "screenshot", "Screenshots"),
    "screenshots": ("kind", "screenshot", "Screenshots"),
    "document": ("kind", "document", "Documents"),
    "documents": ("kind", "document", "Documents"),
    "live photo": ("live", True, "Live Photos"),
    "live photos": ("live", True, "Live Photos"),
    "favourite": ("favourites", True, "Favourites"),
    "favourites": ("favourites", True, "Favourites"),
    "favorite": ("favourites", True, "Favourites"),
    "favorites": ("favourites", True, "Favourites"),
    "starred": ("favourites", True, "Favourites"),
}

_MAX_PHRASE = 4          # longest name or place worth trying, in words
_TOKEN = re.compile(r"[^\W_]+", re.UNICODE)


@dataclass
class Parsed:
    #: every person named in the query — a photo must contain all of them
    person_ids: list[int] = field(default_factory=list)
    country: str | None = None
    state: str | None = None
    city: str | None = None
    album_id: int | None = None
    since: str | None = None
    until: str | None = None
    month: int | None = None
    solo: bool = False
    live: bool = False
    media_type: str | None = None
    kind: str | None = None
    #: what is left for the model — the part that is about what a picture shows
    text: str = ""
    #: one per thing understood, for the UI to show its working
    chips: list[dict] = field(default_factory=list)

    @property
    def has_filters(self) -> bool:
        return bool(self.chips)

    def filter_kwargs(self) -> dict:
        return {
            "person_ids": self.person_ids, "country": self.country, "state": self.state,
            "city": self.city, "album_id": self.album_id, "since": self.since,
            "until": self.until, "month": self.month, "solo": self.solo,
            "live": self.live, "media_type": self.media_type, "kind": self.kind,
            "curated": True,
        }


# ---- the lexicon of everything nameable in this library ---------------------
_lock = threading.Lock()
_lex: dict[str, tuple[str, object, str]] | None = None
_lex_stamp: tuple | None = None


def _stamp() -> tuple:
    """Cheap "has anything nameable changed" check — renaming a person or
    geocoding a new city has to reach the parser without a restart."""
    p = db.query_one("SELECT COUNT(*) n, COALESCE(MAX(id), 0) hi FROM persons WHERE name IS NOT NULL")
    pl = db.query_one("SELECT COUNT(*) n FROM file_places")
    return (p["n"], p["hi"], pl["n"])


def lexicon() -> dict[str, tuple[str, object, str]]:
    """phrase -> (field, value, label), lowercased, for exact phrase matching."""
    global _lex, _lex_stamp
    stamp = _stamp()
    with _lock:
        if _lex is not None and _lex_stamp == stamp:
            return _lex
        lex: dict[str, tuple[str, object, str]] = {}
        # Places first, then people over the top of them: a person someone took
        # the trouble to name is more likely what they meant than a city that
        # happens to share the spelling.
        for col, field_name in (("country", "country"), ("state", "state"), ("city", "city")):
            for r in db.query(
                    f"SELECT DISTINCT {col} v FROM file_places WHERE {col} IS NOT NULL AND {col} != ''"):
                lex[r["v"].lower()] = (field_name, r["v"], r["v"])
        for r in db.query("SELECT id, name FROM persons WHERE name IS NOT NULL AND name != ''"):
            lex[r["name"].lower()] = ("person_id", r["id"], r["name"])
        _lex, _lex_stamp = lex, stamp
        return lex


def _prefix_person(tok: str, lex: dict) -> tuple[int, str] | None:
    """"harsh" when the person is "Harshh".

    Only for a token long enough to mean something and only when exactly one
    name starts with it — an ambiguous prefix is not a name someone typed, it
    is a word, and belongs to the model."""
    if len(tok) < 4:
        return None
    hits = {v[1]: v[2] for k, v in lex.items() if v[0] == "person_id" and k.startswith(tok)}
    if len(hits) == 1:
        pid, label = next(iter(hits.items()))
        return pid, label
    return None


def _year(tok: str) -> int | None:
    return int(tok) if re.fullmatch(r"(19|20)\d{2}", tok) else None


def parse(query: str) -> Parsed:
    out = Parsed()
    raw = query.strip()
    if not raw:
        return out
    lex = lexicon()

    # An explicit ISO date is unambiguous, and has to be taken out of the string
    # rather than merely recognised in it — the tokenizer would otherwise leave
    # "2024", "03" and "15" behind to be sent to the model as search terms.
    iso = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", raw)
    if iso:
        day = iso.group(0)
        out.since, out.until = day, day + "z"
        out.chips.append({"kind": "date", "label": day})
        raw = raw[: iso.start()] + " " + raw[iso.end():]
    tokens = _TOKEN.findall(raw.lower())

    leftover: list[str] = []
    year: int | None = None
    month: int | None = None
    i = 0
    while i < len(tokens):
        # longest phrase first, so "Arjun Chacha" never matches as "Arjun"
        hit = None
        for n in range(min(_MAX_PHRASE, len(tokens) - i), 0, -1):
            phrase = " ".join(tokens[i:i + n])
            if phrase in _MODIFIERS:
                hit = (n, _MODIFIERS[phrase])
                break
            if phrase in lex:
                hit = (n, lex[phrase])
                break
        if hit:
            n, (field_name, value, label) = hit
            if field_name == "favourites":
                out.album_id = favourites.album_id()
                out.chips.append({"kind": "album", "label": label})
            elif field_name == "person_id":
                # A name repeated is still one person; a second name is a
                # second filter, not a replacement for the first. Overwriting
                # was the bug: the chips said "Yash, Karan" and the query
                # asked only for Karan.
                if value not in out.person_ids:
                    out.person_ids.append(value)
                    out.chips.append({"kind": "person", "label": label})
            elif field_name in ("country", "state", "city"):
                setattr(out, field_name, value)
                out.chips.append({"kind": "place", "label": label})
            else:
                setattr(out, field_name, value)
                out.chips.append({"kind": "filter", "label": label})
            i += n
            continue

        tok = tokens[i]
        near = _prefix_person(tok, lex)
        if near is not None:
            pid, label = near
            if pid not in out.person_ids:
                out.person_ids.append(pid)
                out.chips.append({"kind": "person", "label": label})
            i += 1
            continue
        y = _year(tok)
        if y is not None and not iso:
            year = y
            i += 1
            continue
        if tok in _MONTHS and not iso:
            month = _MONTHS[tok]
            i += 1
            continue
        if tok not in _STOP:
            leftover.append(tok)
        i += 1

    if not iso and (year or month):
        _apply_date(out, year, month)
    if out.solo and len(out.person_ids) > 1:
        for c in out.chips:
            if c["label"] == "Solo":
                c["label"] = "Nobody else"
    out.text = " ".join(leftover)
    return out


def _apply_date(out: Parsed, year: int | None, month: int | None) -> None:
    if year and month:
        end_y, end_m = (year + 1, 1) if month == 12 else (year, month + 1)
        out.since = f"{year:04d}-{month:02d}-01"
        out.until = f"{end_y:04d}-{end_m:02d}-01"
        out.chips.append({"kind": "date", "label": f"{_month_name(month)} {year}"})
    elif year:
        out.since, out.until = f"{year:04d}-01-01", f"{year + 1:04d}-01-01"
        out.chips.append({"kind": "date", "label": str(year)})
    elif month:
        out.month = month
        out.chips.append({"kind": "date", "label": f"Every {_month_name(month)}"})


def _month_name(m: int) -> str:
    return [k for k, v in _MONTHS.items() if v == m and len(k) > 3][0].capitalize()
