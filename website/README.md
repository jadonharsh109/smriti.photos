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

## Keeping it honest

The copy is drawn from the root `README.md`. When a feature lands or changes,
change it in both — this page is the first thing anyone reads about Smriti, and
a page that overstates what the app does is worse than no page.

Download buttons deliberately point at
`releases/latest` rather than a pinned version, so a new release needs no edit here.
