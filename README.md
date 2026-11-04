# LiveDesk

A live event results platform. Its first module tracks the **2026 U.S. midterm elections** (November 3, 2026): Senate, House and governor results, with clearly labelled race calls, a source and fetch time on every figure, and an audited admin panel. The core (events, sources, adapters, reconciliation, live updates, admin) does not depend on elections, so other countries and other event types plug in through configuration plus one module file.

## Run it tonight (live data)

Requirements: Node.js 22.13 or later. No database server, no build step, no API keys.

```bash
npm install            # only needed for the map build script; the server itself has no dependencies
ADMIN_USERS="you:admin:choose-a-long-token" npm start
# open http://localhost:8080
```

The server pulls the free civicAPI feed once a minute per national race (3 requests a minute in total) and pushes changes to every open browser over Server-Sent Events. Readers never contact civicAPI directly, so traffic on the site does not reach the data provider.

## Try it with simulated data

```bash
npm run sample                                   # counts start at 0% and fill in over 30 minutes
LIVEDESK_SAMPLE_START=0.8 npm run sample         # jump to 80% of the way through the night
```

Sample mode keeps everything in memory, uses fictitious candidate names, and shows a yellow **SAMPLE DATA** banner on every page.

## What is implemented

| Area | Status |
|---|---|
| Live ingestion from civicAPI (Senate 35, House 435, Governor 36) | Done. Field mapping checked against live civicAPI responses; not yet run against election-night data from this workspace (see "Testing") |
| Race calls only from named sources; conflicting and withdrawn calls | Done, unit-tested |
| Data checks that hold implausible counts (pre-poll-close, votes above population, negative, out-of-range, source test flag) | Done, unit-tested |
| Multi-source reconciliation, priority, discrepancy reporting, automatic failover | Done, unit-tested |
| National overview: chamber balance with majority line, called/remaining, Senate net change, control only from called seats | Done |
| Interactive state map (Senate / Governor / House layers), hatching for "leading" so colour is not the only cue, keyboard access, list alternative for phones | Done |
| Live updates feed (calls, withdrawn calls, conflicts, lead changes, first results, count jumps, control, editor announcements), each with source and time | Done |
| Close-race tracker with configurable thresholds (1 pt very close, 5 pts competitive) | Done |
| Search, filters (office, party, status, state), sorting (competitive, margin, reporting, updated) | Done |
| State pages, race pages (bars, margin, reporting definition, call source, sources, discrepancies, RCV/runoff and redistricting notes) | Done |
| County results on a race page | Done on request (one cached provider call per race per minute, max 3 in flight). Table only; no county map yet |
| Follow races or states, in-page alerts, optional browser notifications | Done (stored in the reader's browser) |
| Shareable links and a downloadable PNG card per race | Done |
| Dark and light themes, English and Spanish interface, time-zone switcher | Done |
| Admin panel with roles (viewer, editor, admin) and an audit log: create events, edit sources, refresh intervals, manual calls (must cite source and link), holds, corrections, announcements, JSON uploads | Done |
| Methodology page generated from the live configuration | Done |
| AP Elections API adapter | Written from AP's documentation; **needs a paid key** (`AP_API_KEY`) and testing against AP data |
| Official state/county feeds (Clarity/Civix) | Generic adapter written; **each jurisdiction needs configuring** (state, election id, contest-name mapping) |
| State legislative, ballot measure and local races | civicAPI race search adapter is present but **off by default**: the search response format is undocumented and could not be verified. Turn on in the event config, or upload races as JSON |
| Historical comparisons | Display is built; **data must be imported** (for example MIT Election Data and Science Lab files, converted to the upload format) |
| 2026 congressional district map | **Blocked on data**: the Census Bureau's 120th Congress boundary files were still "coming soon" |
| Other event types (economics, sports) | Architecture and admin support them; **no module written yet** |

## Configuration

Environment variables:

| Variable | Meaning |
|---|---|
| `PORT` | HTTP port (default 8080) |
| `DB_FILE` | SQLite file (default `data/livedesk.db`) |
| `ADMIN_USERS` | Comma-separated `name:role:token` entries. Roles: `viewer`, `editor`, `admin` |
| `AP_API_KEY` | Enables the AP adapter once you also set `enabled: true` for the `ap` source |
| `CONFIG_OVERWRITE=1` | Re-seed events from `config/events/*.json`, replacing admin edits |
| `LIVEDESK_USER_AGENT` | User-Agent sent to providers |
| `LIVEDESK_SAMPLE=1` | Sample-data mode (see above) |

Events live in `config/events/*.json` on first start, then in the database, where the admin panel edits them. The U.S. event file sets chamber sizes and majorities, seats not up, the Senate seat list used for net change, close-race thresholds, ranked-choice and runoff notes, and the list of states with new 2026 district lines.

## Deploying

Any host that runs a long-lived Node process works: Render, Railway, Fly.io, a small VPS. Use one instance (the SQLite store and the scheduler are in-process) and a persistent disk for `data/`.

```bash
docker build -t livedesk . && docker run -p 8080:8080 -v $PWD/data:/app/data -e ADMIN_USERS=you:admin:token livedesk
```

For election-night traffic, put a CDN (for example Cloudflare's free plan) in front. API responses already carry `ETag` and `Cache-Control: s-maxage` headers of 5 to 30 seconds, so the CDN absorbs repeat reads, and the server makes the same small number of provider requests no matter how many readers arrive. The live stream (`/api/events/:id/stream`) must not be buffered; the server sends `X-Accel-Buffering: no` for nginx.

Vercel is not a good fit for the backend, because it does not keep a scheduler running between requests. If you want Vercel for the front end, serve `public/` there and point it at the Node server's URL.

## After election night

- **Counting continues for days.** Leave the server running; civicAPI keeps updating and calls arrive as the source makes them.
- **Runoffs** (for example Georgia, which requires 50% in general elections): create a new event in the admin panel, or add the runoff contests by JSON upload. Contest ids stay stable, so followers keep their alerts.
- **Recounts:** an editor can hold a race, publish an announcement citing the election office, and mark a call withdrawn.
- **Certification:** an editor marks races certified, citing the official certification link (required). Set the event to `completed` to stop polling; `archived` keeps it searchable.

## Testing

```bash
npm test     # 11 tests: civicAPI mapping, held counts, priority and failover, conflicting and withdrawn calls, chamber math, HTTP, roles, audit
```

What was checked while building: the full pipeline in sample mode; screenshots at desktop and phone widths in light and dark themes; the admin sign-in, hold and audit flow. What could not be checked: live civicAPI traffic on election night (the build workspace could not reach civicAPI), and the AP, Clarity and civicAPI-search adapters against real responses.

## Data sources and licences

See `docs/SOURCES.md`. civicAPI requires attribution, which the site footer and methodology page provide. Do not enable a source until you have confirmed its terms allow your use.
