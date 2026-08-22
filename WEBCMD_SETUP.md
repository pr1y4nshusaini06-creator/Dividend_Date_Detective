# Webcmd Rebuild — Setup Notes

This project now uses real **webcmd** adapters instead of raw Playwright
scraping. Read this before hackathon day so setup doesn't eat your build
time.

## What changed

- `webcmd-plugin/dividend-india/` — three real webcmd adapters:
  - `moneycontrol-dividend.js` — ex-dividend date/amount from Moneycontrol
  - `tickertape-dividend.js` — same, from Tickertape (cross-reference source)
  - `market-price.js` — current price, NSE primary / Yahoo Finance fallback
- `agent/webcmdRunner.js` — shells out to the `webcmd` CLI and parses JSON
  output. Replaces `agent/scraper.js` (kept in the repo for reference /
  fallback, but `server.js` no longer imports it).
- `server.js` — now requires `./agent/webcmdRunner` instead of
  `./agent/scraper`. `/api/analyze` and `/api/demo` behave identically from
  the frontend's point of view — same request/response shape.
- `/api/memory` — now calls webcmd's own `site memory show` command instead
  of a custom cache. This is real webcmd site memory.

## One-time setup (do this tonight, not during the hackathon)

```bash
cd dividend-date-detective
npm install
npx webcmd plugin install file://$PWD/webcmd-plugin/dividend-india
```

You should see `✅ Plugin "dividend-india" installed successfully.`

## Verify the adapters actually work against the live sites

This is the step that matters most. Selectors in the adapters are
best-effort — written without live access to moneycontrol.com/tickertape.in
from the dev sandbox — so they need to be checked against the real DOM.

```bash
npx webcmd browser verify dividend-india/moneycontrol-dividend
npx webcmd browser verify dividend-india/tickertape-dividend
npx webcmd browser verify dividend-india/market-price
```

If verify fails, run with tracing on to see exactly what broke:

```bash
npx webcmd dividend-india moneycontrol-dividend ITC --trace on --keep-tab true --window foreground
```

`--window foreground` pops the actual browser window so you can watch it
navigate and see where a selector doesn't match. `--trace on` writes a
trace artifact — check `summary.md` in the trace output for the entry
point.

### If a selector is wrong

Open the relevant `.js` file in `webcmd-plugin/dividend-india/`, open
devtools on the real page, find the real selector/class names for the
dividend table or price element, and update the `sectionSelectors` /
`rowSelectors` arrays (or the CSS selectors in `market-price.js`'s NSE/Yahoo
paths — though those two are JSON APIs and much less likely to need
changes).

Re-run `webcmd validate dividend-india` after any edit — it's instant and
catches schema mistakes before you burn time on `browser verify`.

## Running the app

```bash
npm start
```

Then open `public/index.html` (or wherever your frontend serves from) and
run a real lookup. Watch the terminal — you'll see the `webcmd` CLI actually
launch its own bundled Chromium and navigate.

## Demo tip: show the site memory

After looking up the same stock twice, hit:

```
GET /api/memory
```

This calls `webcmd site memory show dividend-india` under the hood — if
verify ran successfully at least once, you'll see real remembered
endpoints/fields here. This is your "explore once, learn, reuse" demo
moment, and unlike the earlier custom cache, it's the actual webcmd memory
system, not something we simulated.

## Fallback: demo mode always works

`POST /api/demo` never touches the network or webcmd at all — it's fully
canned data run through the same analyzer. If live verification isn't
solid by demo time, lead with a live attempt and fall back to demo mode
live on stage; that's a legitimate "recovery" story, not a failure.

## Known sandbox limitation (informational only)

Adapters were written and schema-validated (`webcmd validate` passes with
0 errors) but could not be tested against live sites from the dev sandbox
used to build this — no outbound access to moneycontrol.com/tickertape.in/
nseindia.com, and no working headless display for webcmd's bundled
browser. This is why the live-site verification step above is mandatory,
not optional, before the hackathon.
