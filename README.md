# Penn Grad Events

A one-page site: a tilted 3D wireframe map of Penn's campus and Pennovation with event pins, plus a sidebar of event cards. Click a pin or card to see the full event.

## How it works

```
Google Sheet ──(daily GitHub Action)──► scripts/build_data.py ──► data/events.json ──► index.html
   (private)                              removes personal info      (public, cleaned)
```

- The browser never reads the Google Sheet. A GitHub Action runs every morning at about 8:30 AM ET. It downloads the sheet using the `SHEET_ID` secret, cleans it, and commits `data/events.json`.
- **Removed before publishing:** the `Source email` column, personal calendar invites and Canvas/course announcements, passwords, and Zoom links.
- **Map:** only Penn campus and Pennovation, using [OpenFreeMap](https://openfreemap.org) tiles (free, no API key). Events elsewhere (center city, virtual, Harrisburg) appear in the sidebar under "Virtual / beyond campus".
- **Posters:** if an event's info link has a preview image (`og:image`), that image is used. Otherwise the site draws a wireframe poster. To add a poster by hand, for example one from Instagram, put it in `data/posters.json`:
  ```json
  { "VIP-X Showcase & Founder Mixer": "https://…/poster.jpg" }
  ```
- **New buildings:** if a building doesn't get a pin, add it to `data/places.json` (name, match keywords, lat/lng).
- **Linking a specific day:** add `#2026-12-02` to the URL.

## Run locally

```sh
SHEET_ID=<your sheet id> python scripts/build_data.py   # refresh data
python -m http.server 8000                              # open http://localhost:8000
```

## Publish on GitHub Pages

1. Create a GitHub repo and push this folder to its `main` branch.
2. Under **Settings → Secrets and variables → Actions → New repository secret**, add `SHEET_ID`. This is the long ID in the sheet's URL, between `/d/` and `/edit`.
3. Under **Settings → Pages**, set Source to "Deploy from a branch", branch `main`, folder `/ (root)`.
4. Under **Actions → Update events → Run workflow**, run it once to test. After that it runs daily.

Notes:
- GitHub Pages on a free account needs a public repo. The repo only ever contains the cleaned `events.json`, never the sheet ID.
- The sheet itself is still viewable by anyone who has its link. Consider changing its sharing setting to "Restricted". If you do, the Action can't read it anonymously, so you'd need a service account.
