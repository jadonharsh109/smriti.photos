# smriti.photos — the marketing site

One static page. No build step, no dependencies, no external requests: every
style, script and icon is inline, so it renders from a single file.

## Preview it

```bash
npx serve website        # or: python3 -m http.server -d website 8000
```

## Deploy to Vercel

```bash
npm i -g vercel
vercel --cwd website            # preview
vercel --cwd website --prod     # production
```

Or point a Vercel project at this repo and set **Root Directory** to `website`.
There is no framework and no build command — Vercel serves `index.html` as-is.

## The illustrations

The three drawings — the app window, the drive, the three-step flow — are inline
SVG, and they are **illustrations, not screenshots**. That is deliberate and the
captions say so: real screenshots of a real library show real faces, and the
sample library in `test-library/` renders as empty gradient tiles, which would
undersell the app rather than explain it.

When there are screenshots worth publishing, drop them in beside `og.png` and
replace the `<svg>` inside each `<figure class="shot">` with an `<img>`. The
figure, caption and framing already fit.

## The demo footage

`demo.mp4` / `demo.webm` play in the hero; `demo-poster.jpg` holds the first frame
until they do; `demo.gif` is the same tour for the repo README, where video does
not embed reliably.

All four were recorded from the real app driven through Timeline → Places → Map
→ Events, then crossfaded and encoded locally with ffmpeg. Nothing was uploaded
to a hosted recorder — which would be a strange thing to do for an app whose
argument is that nothing leaves your machine.

The library on screen is **not a real one**. It was built from public-domain and
CC0 photographs fetched from Wikimedia Commons and stamped with plausible dates
and GPS, so the timeline, places and trips have something true to group. A real
library would mean publishing real faces.

## The share card

`og.png` is the 1200x630 image Slack, X, WhatsApp and LinkedIn show. Regenerate
it after a wording change:

```bash
python scripts/make_og_image.py
```

It is Latin-only on purpose — see the note at the top of that script.

## The Status cut

`demo-status.mp4` is a 1080x1920 version for WhatsApp / Instagram Status —
19 seconds, 1.4 MB, the tour looped twice. `demo-status.jpg` is its first frame,
for anywhere that wants a still.

It lives here rather than in a downloads folder so it can be fetched from a
phone: open <https://smriti.jadonharsh.in/demo-status.mp4>, hold, save, post.

    python scripts/make_status_video.py

The footage is 2:1 because the app is, so this composes rather than crops —
cropping to 9:16 would cut the sidebar, which is the part that shows there is a
library here and not just a grid of photos.

## The download counter

The footer carries a live count of installer downloads, read from the GitHub
releases API in the visitor's browser.

It counts **installers only** — `.dmg`, `-aarch64.zip`, `setup.exe`. The other
release assets are the app talking to itself: `latest.json` is the updater
checking on every launch, `Smriti.app.tar.gz` is the payload it then pulls.
Those run several times higher and measure installs that already exist, so
counting them would flatter the number rather than report it. At the time of
writing that is 15 people against 171 of updater traffic.

It hides itself only when the count is zero or the request failed — "0
downloads" would report a rate limit or an offline visitor as a fact about the
app. Cached in `localStorage` for six hours. GitHub allows 60 unauthenticated
requests an hour per IP, which is per visitor, so it cannot exhaust anyone's
budget.

`python scripts/downloads.py --by-tag` reports the same figures from a
terminal, with updater traffic broken out separately.

Worth knowing: this is the one request the page makes to anybody else. It is
sent with no referrer, and it is the marketing site rather than the app — but
if you would rather the page talk to nobody at all, bake the number in at
deploy time and drop the script.

## The domain

Live at <https://smriti.jadonharsh.in>. That host is written into `canonical`,
`og:url`, `twitter:image`, the JSON-LD and `sitemap.xml`. If it ever moves,
change it in all five or search engines will be told the real page is somewhere
it isn't.

## Keeping it honest

The copy is drawn from the root `README.md`. When a feature lands or changes,
change it in both — this page is the first thing anyone reads about Smriti, and
a page that overstates what the app does is worse than no page.

Download buttons deliberately point at
`releases/latest` rather than a pinned version, so a new release needs no edit here.
