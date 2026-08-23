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
