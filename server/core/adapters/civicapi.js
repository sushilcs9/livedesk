// civicAPI adapter (https://www.civicapi.org/, free, keyless; attribution required).
// Field names verified against live responses for races 87524 (House), 87528 (Senate), 87535 (Governors).
//
// National race objects hold one region per seat (keys "ga", "ca-22", "ak-al") with candidates,
// votes, percent_reporting and a per-candidate `winner` flag. civicAPI does not document whether
// percent_reporting means precincts or expected vote, so it is passed through with that caveat.
import { politeFetch, normalizeParty, num, US_STATES } from '../util.js';
import { contestId, OFFICE_LABELS } from '../contest.js';

const REPORTING_DEF = 'civicAPI "percent_reporting" as published. civicAPI does not state whether this is the share of precincts reporting or the share of expected votes counted.';

export function normalizeRegion({ office, key, region, raceMeta, sourceUrl, fetchedAt }) {
  const [st, distRaw] = key.split('-');
  const state = st.toUpperCase();
  if (!US_STATES[state]) return null;
  const district = office === 'us_house' ? (distRaw === 'al' ? 'AL' : String(Number(distRaw))) : (distRaw || null);
  const id = office === 'us_house' ? contestId(office, state, district) : contestId(office, state, null, distRaw || null);
  const candidates = (region.candidates || []).map(c => {
    const p = normalizeParty(c.party);
    return {
      id: String(c.candidate_id ?? c.name), name: c.name, party: p.code, partyLabel: p.label,
      incumbent: !!c.incumbent, votes: num(c.votes), pct: num(c.percent), winner: !!c.winner, advanced: !!c.advanced
    };
  });
  const winners = candidates.filter(c => c.winner);
  const reportingVal = num(region.percent_reporting);
  return {
    id, office, officeLabel: OFFICE_LABELS[office], level: 'federal',
    jurisdiction: { country: 'US', state, district, name: region.name || US_STATES[state] },
    kind: 'candidate',
    candidates,
    reporting: { value: reportingVal, label: reportingVal == null ? 'Not reported' : `${reportingVal}% reporting`, definition: REPORTING_DEF },
    call: winners.length
      ? { status: 'projected', winnerIds: winners.map(w => w.id), by: 'civicAPI', at: raceMeta.last_updated ?? fetchedAt, sourceUrl, note: 'Winner flag set by civicAPI. civicAPI does not publish its race-call methodology.' }
      : { status: 'none', winnerIds: [] },
    sourceRaceId: region.election_id ?? null,
    flags: raceMeta.test_data ? ['held:source-test-data'] : [],
    provenance: {
      sourceId: 'civicapi', sourceName: 'civicAPI', url: sourceUrl,
      humanUrl: region.election_id ? `https://www.civicapi.org/results/${region.election_id}` : 'https://www.civicapi.org/decision-2026',
      fetchedAt, sourceUpdatedAt: raceMeta.last_updated ?? null
    }
  };
}

function holdoverFromRace(race) {
  const out = {};
  for (const c of race.candidates || []) {
    const seats = num(c.seats);
    if (seats) out[normalizeParty(c.party).code] = (out[normalizeParty(c.party).code] || 0) + seats;
  }
  return Object.keys(out).length ? out : null;
}

const OFFICE_FROM_TYPE = [
  [/senate/i, t => /state/i.test(t) ? 'state_senate' : 'us_senate'],
  [/house|assembly|representative|delegates/i, t => /state|assembly|delegates/i.test(t) ? 'state_house' : 'us_house'],
  [/lieutenant/i, () => 'lt_governor'], [/governor/i, () => 'governor'],
  [/attorney general/i, () => 'attorney_general'], [/secretary of state/i, () => 'secretary_of_state'],
  [/measure|proposition|amendment|referend|initiative|question|issue/i, () => 'ballot_measure'],
  [/mayor/i, () => 'mayor'],
];

/** Normalizes a stand-alone civicAPI race (from /race/{id}) that is not part of a national roll-up. */
export function normalizeStandalone(race, raceId, sourceUrl, fetchedAt) {
  const type = `${race.election_type ?? ''} ${race.election_name ?? ''}`;
  let office = 'other';
  for (const [re, f] of OFFICE_FROM_TYPE) if (re.test(type)) { office = f(type); break; }
  const state = String(race.province ?? '').toUpperCase();
  if (!US_STATES[state]) return null;
  const candidates = (race.candidates || []).map(c => {
    const p = normalizeParty(c.party);
    return { id: String(c.candidate_id ?? c.name), name: c.name, party: p.code, partyLabel: p.label, incumbent: !!c.incumbent,
      votes: num(c.votes), pct: num(c.percent), winner: !!c.winner, advanced: !!c.advanced };
  });
  const winners = candidates.filter(c => c.winner);
  const r = num(race.percent_reporting);
  return {
    id: `civic:${raceId}`, office, officeLabel: race.election_name || OFFICE_LABELS[office],
    level: race.municipality ? 'local' : (office.startsWith('us_') ? 'federal' : 'state'),
    jurisdiction: { country: 'US', state, district: race.district ?? null, name: race.municipality || race.district || US_STATES[state] },
    kind: office === 'ballot_measure' ? 'measure' : 'candidate',
    candidates,
    reporting: { value: r, label: r == null ? 'Not reported' : `${r}% reporting`, definition: REPORTING_DEF },
    call: winners.length ? { status: 'projected', winnerIds: winners.map(w => w.id), by: 'civicAPI', at: race.last_updated ?? fetchedAt, sourceUrl } : { status: 'none', winnerIds: [] },
    regions: regionsOf(race),
    flags: race.test_data ? ['held:source-test-data'] : [],
    provenance: { sourceId: 'civicapi', sourceName: 'civicAPI', url: sourceUrl, humanUrl: `https://www.civicapi.org/results/${raceId}`, fetchedAt, sourceUpdatedAt: race.last_updated ?? null }
  };
}

export function regionsOf(race) {
  return Object.entries(race.region_results || {}).map(([key, r]) => ({
    key, name: r.name ?? key, type: r.type ?? null, reporting: num(r.percent_reporting),
    candidates: (r.candidates || []).map(c => ({ id: String(c.candidate_id ?? c.name), name: c.name, party: normalizeParty(c.party).code, votes: num(c.votes), pct: num(c.percent), winner: !!c.winner }))
  }));
}

export function createCivicApiAdapter(source) {
  const p = source.params;
  const cache = new Map(); // url -> {etag, lastModified, body}
  const searchCursor = { offset: 0, ids: [] };

  async function get(url) {
    const prev = cache.get(url);
    let r;
    try { r = await politeFetch(url, { etag: prev?.etag, lastModified: prev?.lastModified }); }
    catch (e) { // one retry for transient server errors (502/503/504) and timeouts
      if (!(e.status >= 500 || e.name === 'AbortError')) throw e;
      await new Promise(res => setTimeout(res, 3000));
      r = await politeFetch(url, { etag: prev?.etag, lastModified: prev?.lastModified });
    }
    if (r.notModified) return { body: prev.body, notModified: true };
    cache.set(url, { etag: r.etag, lastModified: r.lastModified, body: r.body });
    return { body: r.body, notModified: false };
  }

  return {
    id: source.id,
    describe: () => ({ kind: 'civicapi', license: source.license }),
    async fetch() {
      const fetchedAt = new Date().toISOString();
      const contests = []; const meta = { holdover: {}, races: {} };
      const errors = [];
      for (const [office, raceId] of Object.entries(p.nationalRaces || {})) {
        const url = `${p.baseUrl}/race/${raceId}`;
        let body;
        try { ({ body } = await get(url)); }
        catch (e) { errors.push(`${office} (race ${raceId}): ${e.message}`); continue; } // keep the other races
        meta.races[office] = { raceId, lastUpdated: body.last_updated ?? null, percentReporting: num(body.percent_reporting), testData: !!body.test_data };
        const h = holdoverFromRace(body); if (h) meta.holdover[office] = h;
        for (const [key, region] of Object.entries(body.region_results || {})) {
          const c = normalizeRegion({ office, key, region, raceMeta: body, sourceUrl: url, fetchedAt });
          if (c) contests.push(c);
        }
      }
      if (errors.length && errors.length === Object.keys(p.nationalRaces || {}).length) throw new Error(errors.join('; '));
      if (errors.length) meta.partialErrors = errors;
      // Optional down-ballot coverage (state offices, measures, local). Search shape is not documented,
      // so accept either an array of races or {races|results:[...]} and fetch details in small batches.
      if (p.search?.enabled) {
        const s = p.search;
        const qs = new URLSearchParams({ startDate: s.startDate, endDate: s.endDate, country: s.country, limit: String(s.limit) });
        if (s.query) qs.set('query', s.query);
        try {
          const { body } = await get(`${p.baseUrl}/race/search?${qs}`);
          const list = Array.isArray(body) ? body : (body.races || body.results || []);
          const national = new Set(Object.values(p.nationalRaces || {}).map(String));
          searchCursor.ids = list.map(r => String(r.id ?? r.election_id ?? r.race_id)).filter(id => id && id !== 'undefined' && !national.has(id));
        } catch (e) { meta.searchError = e.message; }
        const batch = searchCursor.ids.slice(searchCursor.offset, searchCursor.offset + (s.maxDetailFetchesPerCycle || 20));
        searchCursor.offset = searchCursor.offset + batch.length >= searchCursor.ids.length ? 0 : searchCursor.offset + batch.length;
        for (const id of batch) {
          try {
            const url = `${p.baseUrl}/race/${id}`;
            const { body } = await get(url);
            const c = normalizeStandalone(body, id, url, fetchedAt);
            if (c && !['us_senate', 'us_house', 'governor'].includes(c.office)) contests.push(c);
          } catch (e) { meta.searchError = e.message; }
        }
      }
      return { contests, meta };
    },
    /** On-demand sub-geography (e.g. counties) for one contest's underlying civicAPI race. Cached by caller. */
    async detail(contest) {
      if (!contest.sourceRaceId) return null;
      const url = `${p.baseUrl}/race/${contest.sourceRaceId}`;
      const { body } = await get(url);
      return { regions: regionsOf(body), url, sourceUpdatedAt: body.last_updated ?? null };
    }
  };
}
