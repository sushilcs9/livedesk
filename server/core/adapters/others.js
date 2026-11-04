// Additional adapters. Each converts one provider's format into canonical contests (see contest.js).
import { politeFetch, normalizeParty, num, US_STATES } from '../util.js';
import { contestId, OFFICE_LABELS } from '../contest.js';

/**
 * AP Elections API v3 (paid licence). Written against AP's published developer guide;
 * NOT tested against live AP data because no key was available while building.
 */
export function createApAdapter(source) {
  const p = source.params;
  const key = process.env.AP_API_KEY;
  let nextRequestUrl = null; // AP supports incremental "nextrequest" URLs
  return {
    id: source.id,
    describe: () => ({ kind: 'ap', license: source.license, configured: !!key }),
    async fetch() {
      if (!key) throw Object.assign(new Error('AP_API_KEY is not set; AP adapter disabled'), { permanent: true });
      const url = nextRequestUrl || `${p.baseUrl}/elections/${p.electionDate}?format=json&level=state&officeID=${p.officeIds.join(',')}&resultsType=l`;
      const r = await politeFetch(url, { headers: { 'x-api-key': key } });
      if (r.notModified) return { contests: [], meta: { notModified: true } };
      nextRequestUrl = r.body.nextrequest || null;
      const fetchedAt = new Date().toISOString();
      const OFF = { S: 'us_senate', H: 'us_house', G: 'governor' };
      const contests = [];
      for (const race of r.body.races || []) {
        const office = OFF[race.officeID]; if (!office) continue;
        const ru = (race.reportingUnits || []).find(u => u.level === 'state') || race.reportingUnits?.[0]; if (!ru) continue;
        const state = race.stateAbbrev || ru.statePostal;
        const district = office === 'us_house' ? (race.seatNum ? String(Number(race.seatNum)) : 'AL') : null;
        const cands = (ru.candidates || []).map(c => {
          const pa = normalizeParty(c.party);
          return { id: String(c.candidateID), name: `${c.first ?? ''} ${c.last ?? ''}`.trim(), party: pa.code, partyLabel: pa.label,
            incumbent: !!c.incumbent, votes: num(c.voteCount), pct: null, winner: c.winner === 'X', advanced: c.winner === 'R' };
        });
        const winners = cands.filter(c => c.winner);
        const eevp = num(ru.eevp);
        contests.push({
          id: contestId(office, state, district), office, officeLabel: OFFICE_LABELS[office], level: 'federal',
          jurisdiction: { country: 'US', state, district, name: US_STATES[state] }, kind: 'candidate', candidates: cands,
          reporting: eevp != null
            ? { value: eevp, label: `${eevp}% expected vote`, definition: 'AP estimated expected vote percentage (EEVP).' }
            : { value: num(ru.precinctsReportingPct), label: `${num(ru.precinctsReportingPct)}% precincts`, definition: 'Share of precincts reporting, per AP.' },
          call: winners.length ? { status: 'projected', winnerIds: winners.map(w => w.id), by: 'The Associated Press', at: race.lastUpdated ?? fetchedAt, sourceUrl: url } : { status: 'none', winnerIds: [] },
          flags: [], provenance: { sourceId: source.id, sourceName: 'The Associated Press', url, fetchedAt, sourceUpdatedAt: ru.lastUpdated ?? null }
        });
      }
      return { contests, meta: {} };
    }
  };
}

/**
 * Clarity / Civix Election Night Reporting (official state and county portals).
 * Reads current_ver.txt, then json/en/summary.json. Contest names are mapped to offices by
 * params.officeMap: { "<regex on contest name>": { "office": "us_house", "district": "3" } }.
 * Reporting is precincts reported / total precincts, labelled as such.
 */
export function createClarityAdapter(source) {
  const p = source.params;
  return {
    id: source.id,
    describe: () => ({ kind: 'clarity', license: source.license }),
    async fetch() {
      if (!p.state || !p.electionId) throw Object.assign(new Error('Clarity source needs params.state and params.electionId'), { permanent: true });
      const base = `https://results.enr.clarityelections.com/${p.state}${p.county ? '/' + p.county : ''}/${p.electionId}`;
      const verRes = await fetch(`${base}/current_ver.txt`, { headers: { 'User-Agent': 'LiveDesk/0.1' } });
      if (!verRes.ok) throw new Error(`Clarity current_ver HTTP ${verRes.status}`);
      const ver = (await verRes.text()).trim();
      const url = `${base}/${ver}/json/en/summary.json`;
      const { body } = await politeFetch(url);
      const fetchedAt = new Date().toISOString();
      const contests = [];
      for (const row of Array.isArray(body) ? body : body.Contests || []) {
        const name = row.C ?? row.name; if (!name) continue;
        const match = Object.entries(p.officeMap || {}).find(([re]) => new RegExp(re, 'i').test(name)); if (!match) continue;
        const { office, district = null } = match[1];
        const names = row.CH || []; const votes = row.V || []; const parties = row.P || [];
        const cands = names.map((n, i) => { const pa = normalizeParty(parties[i]); return { id: `${row.K}-${i}`, name: n, party: pa.code, partyLabel: pa.label, incumbent: false, votes: num(votes[i]), pct: null, winner: false, advanced: false }; });
        const pr = num(row.PR), tp = num(row.TP);
        contests.push({
          id: contestId(office, p.state.toUpperCase(), district), office, officeLabel: name, level: office.startsWith('us_') ? 'federal' : 'state',
          jurisdiction: { country: 'US', state: p.state.toUpperCase(), district, name: p.county || US_STATES[p.state.toUpperCase()] },
          kind: office === 'ballot_measure' ? 'measure' : 'candidate', candidates: cands,
          reporting: { value: pr != null && tp ? Math.round(pr / tp * 1000) / 10 : null, label: pr != null && tp ? `${pr} of ${tp} precincts` : 'Not reported',
            definition: 'Precincts with at least partial results / total precincts, from the official Clarity ENR feed. This is not the share of votes counted.' },
          call: { status: 'none', winnerIds: [] }, flags: [],
          provenance: { sourceId: source.id, sourceName: source.name, url, humanUrl: `${base}/${ver}/`, fetchedAt, sourceUpdatedAt: null }
        });
      }
      return { contests, meta: { version: ver } };
    }
  };
}

/** Generic canonical-format JSON feed (any provider that can publish our format, or an uploaded file). */
export function createJsonFeedAdapter(source) {
  return {
    id: source.id,
    describe: () => ({ kind: 'jsonfeed', license: source.license }),
    async fetch() {
      const { body } = await politeFetch(source.params.url);
      const fetchedAt = new Date().toISOString();
      const contests = (body.contests || []).map(c => ({ ...c, flags: c.flags || [], call: c.call || { status: 'none', winnerIds: [] },
        provenance: { sourceId: source.id, sourceName: source.name, url: source.params.url, fetchedAt, sourceUpdatedAt: body.updated ?? null, ...(c.provenance || {}) } }));
      return { contests, meta: {} };
    }
  };
}
