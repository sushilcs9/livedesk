# Architecture

```
 providers ──► adapters ──► observations ──► reconcile ──► published contests ──► summary / feed ──► SSE + cached REST ──► CDN ──► browsers
 (civicAPI,    (one per     (per source,     (priority,     (SQLite)              (event module)                                    ▲
  AP, Clarity,  format)      deduped by       guards,                                                                                │
  uploads)                   hash)            calls,                                                                     admin panel (roles, audit)
                                              overrides)
```

## Building blocks

| Piece | File | Generic or election-specific |
|---|---|---|
| Event registry | `config/events/*.json`, `events` table | Generic: id, name, category, subcategory, country, regions, dates, status (upcoming, live, completed, archived), languages, time zone, dashboard layout, rules, sources |
| Adapters | `server/core/adapters/*` | Generic interface: `fetch() → { contests, meta }`, optional `detail(contest)`. Register in `adapters/index.js` |
| Canonical record | `server/core/contest.js` | A "contest" with participants, values and a reporting measure. Elections use candidates and votes; a sports module would use teams and scores; an economic release would use indicator values against consensus |
| Store | `server/core/store.js` | SQLite through Node's built-in driver. Replace this one file to move to PostgreSQL |
| Engine | `server/core/engine.js` | Per-source schedulers with jitter and backoff, health tracking, failover, change detection, event bus |
| Reconciliation | `server/core/reconcile.js` | Source priority, no cross-source summing, discrepancies, call rules, sanity guards, editorial overrides |
| Event module | `server/modules/elections/index.js` | Election rules: chamber balance, net change, close races, feed triggers, map cells. Other categories add a module with the same functions (`describeChange`, `summarize`) |
| HTTP | `server/http/server.js` | REST with ETags and CDN cache headers, SSE stream, rate limiting, static files with a strict Content-Security-Policy, admin API with roles and audit |
| Front end | `public/` | No framework or build step. Hash routes per event, state and race |

## Electoral systems

Contest rules are configuration, not code: `rules.electoralSystem`, per-state `runoffRules` (threshold and note), `rankedChoice` notes, and chamber definitions (size, majority, seats not up). The reconciler never decides a winner itself, so proportional, ranked-choice and two-round systems only need: (1) a module `summarize` that turns contest results into seats (for example a D'Hondt allocation for party lists), and (2) adapters that carry round numbers. The canonical record already has room for `round` and `advanced` (for candidates moving to a runoff).

## Scaling path

1. **Now (free or low cost):** one Node process with SQLite on a small host, behind a CDN. Provider load is fixed (3 requests a minute for civicAPI) whatever the audience size.
2. **More traffic:** run the ingestion worker separately from several stateless web instances. Replace `store.js` with PostgreSQL and the in-process event bus with Redis pub/sub. The SSE fan-out then scales horizontally.
3. **Many simultaneous events:** events are already isolated by `event_id` in every table and every bus topic. Add per-event worker processes if one event's providers are slow.

## Planned phases

- Phase 1 (this build): U.S. 2026 midterms.
- Phase 2: international elections — new adapters per country, a seat-allocation function per system, translated interface strings in `public/js/i18n.js`, country maps as pre-projected JSON in `public/data/`.
- Phase 3: economic releases and sports — new modules and dashboard layouts.
- Phase 4: accounts (alerts and favourites shared across devices), push notifications (Web Push), analytics.
