# Election data sources (researched November 3, 2026)

| Source | Coverage | Cost and licence | Access | Speed | Use in LiveDesk |
|---|---|---|---|---|---|
| **civicAPI** (civicapi.org) | All 2026 Senate (35), House (435) and governor (36) races in three national roll-up objects (race ids 87528, 87524, 87535); county detail per state race; claims coverage of down-ballot and international races through `race/search` | Free, no key. Terms on the docs page: free for personal and commercial use, attribution required for non-personal projects. No other terms published, and the operator is not named | `https://civicapi.org/api/v2/race/{id}`, `race/search`, `status`. JSON. CORS open. No published rate limit; LiveDesk makes 3 requests a minute | Independent testers expected about one update a minute | **Primary live source, on by default.** Treated as an unofficial aggregator. Two developers reported problems in October 2026: impossible pre-election counts in the Pennsylvania governor race and gaps or errors in the 2024 archive. Those reports are why LiveDesk holds implausible counts and attributes every call |
| **Associated Press Elections API** | All federal and state races, county level, race calls, expected-vote estimates | Paid licence through AP sales | REST with API key; quota per minute; incremental `nextrequest` URLs | The industry standard for race calls | Adapter written (`ap`), off until `AP_API_KEY` is set. Not tested against AP data |
| **Decision Desk HQ** | All U.S. levels, more than 100,000 races a year; projections | Commercial API by contract. The free "DDHQ Votes" dashboard is for viewing only and gives no redistribution rights | API for clients | Says it beat AP on projections 79% of the time in 2026 primaries (its own figure) | Not integrated. Would be a new adapter once licensed |
| **Clarity / Civix ENR** (results.enr.clarityelections.com) | Official results sites for about 1,000 counties and several states | Public government results. Check each jurisdiction's terms | Anonymous JSON (`current_ver.txt`, then `json/en/summary.json`) and XML zip files | As fast as the official site | Generic adapter written (`clarity`); one source entry per jurisdiction. Example slot included, off |
| **Other state election sites** (for example Georgia, Pennsylvania, Arizona, Texas, California, Florida run their own systems) | Official results | Public records | Formats vary by state | Official | Needs one adapter per format. Not built |
| **FEC OpenFEC API** | Candidate and committee metadata, finance; not results | Free with an api.data.gov key | REST | Not live results | Planned for candidate metadata |
| **Google Civic Information API** | Polling places, contests, officials; no results. Election data expires after election day | Free with key; quota | REST | — | Not used for results |
| **MIT Election Data and Science Lab** | Historical certified results | Open data on Harvard Dataverse (check each dataset's licence) | CSV | Historical | Import through the JSON upload to fill "Earlier elections" |
| **U.S. Census Bureau TIGER/Line** | State and district boundaries | Public domain | Shapefiles | — | State map built from Census boundaries (us-atlas 3.0.1). 120th Congress district files were listed as "coming soon"; ten states (AL, CA, FL, LA, MO, NC, OH, TN, TX, UT) redrew districts for 2026 |
| **News organisations' public JSON** (for example files behind major news sites' results pages) | Broad | Viewable but **not licensed for reuse** | Undocumented | Fast | **Not used.** Publicly viewable is not the same as licensed for redistribution |
| **Prediction markets** (Kalshi, Polymarket) | Odds, not results | Various | — | — | Not used. Odds are not results |

## Rules followed

- No paywalls, CAPTCHAs, sign-ins or site protections are bypassed. Adapters use documented or anonymous public endpoints only, with a named User-Agent, conditional requests (ETag / If-Modified-Since), timeouts and exponential backoff.
- Providers are polled by one background worker. Reader traffic never reaches providers.
- Every published figure records the source, the source URL, the fetch time and the source's own update time when it gives one.
