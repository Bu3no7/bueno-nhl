# Cloudflare Pages setup for Bueno Sports (bueno-nhl)

Netlify paused all deploys (credit limit exceeded), so the site moved here.
The site is pure static HTML/CSS/JS — no build step.

## Project settings (Cloudflare dashboard → Pages → Create project → Connect to Git)

- **Repository:** `Bu3no7/bueno-nhl`
- **Branch:** `main`
- **Build command:** _(leave empty)_
- **Output directory:** `/`
- **Root directory:** _(leave empty)_

## The /nhl-api/* proxy

The NHL API (`api-web.nhle.com`) sends no CORS headers, so browsers refuse
direct cross-origin `fetch()` calls. The proxy that fixes this is
`functions/nhl-api/[[path]].js` — a Pages Function that forwards
`/nhl-api/<path>?<query>` to `https://api-web.nhle.com/v1/<path>?<query>`
and returns the upstream response. It deploys automatically with the site;
no extra configuration needed. GET/HEAD only, no API keys involved.

## Other notes

- `_redirects` keeps `/MODEL.md` returning 404 (same as the old netlify.toml rule).
- `netlify.toml` is intentionally left in the repo in case the site ever moves back.
- The twice-daily sims cron pushes `sims/<date>.json` to this same repo, so
  Cloudflare picks up fresh sims on its normal Git-triggered deploys.
