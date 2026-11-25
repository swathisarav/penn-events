"""
Fetch the events sheet, strip anything private, place events on the Penn map,
look for posters, and write data/events.json for the website.

Usage:  SHEET_ID=<google sheet id> python scripts/build_data.py
The sheet ID is never written to the repo (store it as a GitHub secret).
"""
import csv
import html
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
UA = "penn-grad-events-site/1.0 (static site builder)"
DAYS_AHEAD = 14

# Map bounds: Penn campus + Pennovation. Anything outside gets no pin.
BOUNDS = {"west": -75.2140, "south": 39.9340, "east": -75.1760, "north": 39.9620}


# ---------------------------------------------------------------- helpers
def now_et():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/New_York"))
    except Exception:
        # Windows without tzdata: approximate DST (2nd Sun Mar – 1st Sun Nov).
        utc = datetime.now(timezone.utc)
        y = utc.year
        mar = datetime(y, 3, 8, 7, tzinfo=timezone.utc)
        mar += timedelta(days=(6 - mar.weekday()) % 7)
        nov = datetime(y, 11, 1, 6, tzinfo=timezone.utc)
        nov += timedelta(days=(6 - nov.weekday()) % 7)
        off = -4 if mar <= utc < nov else -5
        return utc.astimezone(timezone(timedelta(hours=off)))


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def load_json(name, default):
    path = os.path.join(DATA, name)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(name, obj):
    with open(os.path.join(DATA, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


NOT_STATED = re.compile(r"^\s*(not stated|not provided|n/?a|none|various)\b", re.I)


def clean(v):
    """Empty / 'Not stated in email' -> None."""
    v = (v or "").strip()
    if not v or NOT_STATED.match(v):
        return None
    return v


def scrub(text):
    """Remove passwords, meeting IDs and Zoom links from free text."""
    if not text:
        return text
    text = re.sub(r"\(?\s*(password|passcode|pwd)\s*[:=]\s*[^\s,;)]+\s*\)?", "", text, flags=re.I)
    text = re.sub(r"https?://\S*zoom\.us/\S+", "", text, flags=re.I)
    text = re.sub(r"meeting id\s*[:#]?\s*[\d ]{9,}", "", text, flags=re.I)
    return re.sub(r"\s{2,}", " ", text).strip(" ,;") or None


# Rows that are personal to the sheet owner, not public events.
PERSONAL = re.compile(r"invitation:|calendar invitation|personal calendar|canvas", re.I)


def is_personal(row):
    blob = " ".join(row.get(k, "") for k in ("Source email", "Notes", "What it is about"))
    return bool(PERSONAL.search(blob))


def category(title, about, food):
    t = f"{title} {about}".lower()
    if re.search(r"defen[cs]e|seminar|lecture|colloquium|thesis|dissertation|talk|symposium|workshop", t):
        return "academic"
    if re.search(r"career|network|recruit|venture|startup|founder|industry|job", t):
        return "career"
    if re.search(r"holiday|market|parade|light|festiv|thanksgiving|gallery|museum|concert|game|sixers", t):
        return "festive"
    if food or re.search(r"lunch|dinner|breakfast|brunch|pizza|coffee|snack|feast", t):
        return "food"
    return "social"


def cost_kind(text):
    """Classify the 'Free event?' wording: free | likely-free | partly-free | paid | unknown."""
    t = (text or "").strip().lower()
    if not t:
        return "unknown"
    if t.startswith("mixed") or "partly" in t:
        return "partly-free"
    if re.match(r"no(?!\s+(cost|charge|fee|payment))", t) or re.search(r"\$\d|paid|tickets? for sale|fee required", t):
        return "paid"
    if t.startswith("yes") or re.search(r"free", t):
        return "free"
    if re.search(r"no cost|no charge|no fee|no payment|no price", t):
        return "likely-free"
    return "unknown"


def duration_min(text):
    """'2 hours' -> 120, '1.5 hours' -> 90, '45 min' -> 45, 'Full day' -> 480; else None."""
    t = (text or "").lower()
    if "full day" in t or "all day" in t:
        return 480
    m = re.search(r"(\d+(?:\.\d+)?)\s*(h|hr|hour)", t)
    mins = round(float(m.group(1)) * 60) if m else 0
    m2 = re.search(r"(\d+)\s*min", t)
    mins += int(m2.group(1)) if m2 else 0
    return mins or None


def is_url(v):
    return bool(v) and re.match(r"^https?://", v.strip(), re.I) is not None


# ---------------------------------------------------------------- places
def in_bounds(lat, lng):
    return BOUNDS["south"] <= lat <= BOUNDS["north"] and BOUNDS["west"] <= lng <= BOUNDS["east"]


def match_known(where, places):
    w = where.lower()
    for p in places["buildings"]:
        if any(k in w for k in p["match"]):
            return {"name": p["name"], "lat": p["lat"], "lng": p["lng"],
                    "color": p.get("color"), "kind": p.get("kind", "building")}
    return None


def geocode(where, places):
    cache = places.setdefault("geocache", {})
    key = where.lower().strip()
    if key in cache:
        return cache[key]
    q = urllib.parse.urlencode({
        "q": f"{where}, Philadelphia, PA",
        "format": "json", "limit": 1,
        "viewbox": f"{BOUNDS['west']},{BOUNDS['north']},{BOUNDS['east']},{BOUNDS['south']}",
        "bounded": 1,
    })
    hit = None
    try:
        time.sleep(1.1)  # Nominatim usage policy: max 1 req/s
        res = json.loads(fetch(f"https://nominatim.openstreetmap.org/search?{q}"))
        if res:
            lat, lng = float(res[0]["lat"]), float(res[0]["lon"])
            if in_bounds(lat, lng):
                hit = {"lat": round(lat, 6), "lng": round(lng, 6)}
    except Exception as e:
        print(f"  geocode failed for {where!r}: {e}", file=sys.stderr)
        return None  # don't cache failures
    cache[key] = hit
    return hit


def locate(where, campus, places):
    """Return list of pins inside the campus/Pennovation map."""
    if not where:
        return []
    pins = []
    for part in re.split(r";|\s\+\s", where):
        part = part.strip()
        if not part or re.search(r"\bvirtual\b|\bzoom\b", part, re.I):
            continue
        known = match_known(part, places)
        if known:
            pins.append(known)
            continue
        # Far-away events ("Off campus — Philly", Harrisburg, ...) are never on this map.
        if campus and re.search(r"off campus", campus, re.I) and "near campus" not in campus.lower():
            continue
        hit = geocode(part, places)
        if hit:
            pins.append({"name": part.split(",")[0], **hit})
    return pins


# ---------------------------------------------------------------- posters
OG = re.compile(
    r'<meta[^>]+(?:property|name)=["\'](?:og:image|twitter:image)(?::src)?["\'][^>]*>', re.I)
CONTENT = re.compile(r'content=["\']([^"\']+)["\']', re.I)
SKIP_POSTER_HOSTS = ("docs.google.com", "forms.gle", "zoom.us", "qualtrics.com", "bit.ly")


def find_poster(link, cache):
    if not is_url(link):
        return None
    host = urllib.parse.urlparse(link).netloc.lower()
    if any(h in host for h in SKIP_POSTER_HOSTS):
        return None
    if link in cache:
        return cache[link]
    img = None
    try:
        page = fetch(link, timeout=15)
        for tag in OG.findall(page):
            m = CONTENT.search(tag)
            if m:
                cand = urllib.parse.urljoin(link, html.unescape(m.group(1)))
                if not re.search(r"logo|default|placeholder|favicon", cand, re.I):
                    img = cand
                    break
    except Exception as e:
        print(f"  poster lookup failed for {link}: {e}", file=sys.stderr)
        return None
    cache[link] = img
    return img


# ---------------------------------------------------------------- main
def main():
    sheet_id = os.environ.get("SHEET_ID", "").strip()
    if not sheet_id:
        sys.exit("SHEET_ID environment variable is required")

    url = (f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?"
           + urllib.parse.urlencode({"tqx": "out:csv", "sheet": "All Events"}))
    rows = list(csv.DictReader(io.StringIO(fetch(url))))
    print(f"fetched {len(rows)} rows")

    places = load_json("places.json", {"buildings": [], "geocache": {}})
    overrides = load_json("posters.json", {})
    poster_cache = load_json("poster_cache.json", {})

    today = now_et().date()
    last = today + timedelta(days=DAYS_AHEAD)
    events, skipped_personal = [], 0

    for i, r in enumerate(rows):
        try:
            d = datetime.strptime(r.get("Date", "").strip(), "%Y-%m-%d").date()
        except ValueError:
            continue
        if not (today <= d <= last):
            continue
        if is_personal(r):
            skipped_personal += 1
            continue

        title = scrub(clean(r.get("Event")))
        if not title:
            continue
        about = scrub(clean(r.get("What it is about")))
        where = scrub(clean(r.get("Where")))
        campus = clean(r.get("On / Off campus"))
        food = clean(r.get("Food / snacks?"))
        free_raw = (r.get("Free event?") or "").strip()
        free = clean(free_raw)
        reg_flag = clean(r.get("Registration link?"))
        raw_link = (r.get("Registration / info link") or "").strip()
        link = raw_link if is_url(raw_link) and "zoom.us" not in raw_link else None
        link_note = scrub(clean(raw_link)) if raw_link and not is_url(raw_link) else None
        virtual = bool(re.search(r"virtual|zoom|online", f"{where} {campus}", re.I))

        poster = overrides.get(title) or find_poster(link, poster_cache)
        events.append({
            "id": f"{d.isoformat()}-{i}",
            "date": d.isoformat(),
            "title": title,
            "about": about,
            "organiser": scrub(clean(r.get("Organiser"))),
            "start": clean(r.get("Start time")) or (r.get("Start time") or "").strip() or None,
            "end": clean(r.get("End time")),
            "durationMin": duration_min(r.get("Duration")),
            "where": where,
            "campus": campus,
            "virtual": virtual,
            "places": locate(where, campus, places),
            "food": food if food and not food.lower().startswith("no") else None,
            "free": free_raw or None,
            "cost": cost_kind(free_raw),
            "registration": None if not reg_flag or reg_flag.lower().startswith("no") else reg_flag,
            "link": link,
            "linkNote": link_note,
            "notes": scrub(clean(r.get("Notes"))),
            "category": category(title, about or "", food),
            "poster": poster,
        })

    events.sort(key=lambda e: (e["date"], minutes(e["start"]), e["title"]))
    save_json("events.json", {
        "lastUpdated": now_et().strftime("%Y-%m-%dT%H:%M"),
        "events": events,
    })
    save_json("places.json", places)
    save_json("poster_cache.json", poster_cache)
    print(f"wrote {len(events)} events ({skipped_personal} personal rows removed)")


def minutes(t):
    m = re.match(r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m", t or "", re.I)
    if not m:
        return 24 * 60
    h = int(m.group(1)) % 12 + (12 if m.group(3).lower() == "p" else 0)
    return h * 60 + int(m.group(2) or 0)


if __name__ == "__main__":
    main()
