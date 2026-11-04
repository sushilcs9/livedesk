// SAMPLE DATA generator for development and demos. Emits objects in civicAPI's exact response
// shape and runs them through the real civicAPI normalizer, so the whole pipeline is exercised.
// Every contest it produces carries the "sample-data" flag and fictitious candidate names.
import { normalizeRegion } from './civicapi.js';

export const HOUSE_SEATS = { AL:7,AK:1,AZ:9,AR:4,CA:52,CO:8,CT:5,DE:1,FL:28,GA:14,HI:2,ID:2,IL:17,IN:9,IA:4,KS:4,KY:6,LA:6,ME:2,MD:8,MA:9,MI:13,MN:8,MS:4,MO:8,MT:2,NE:3,NV:4,NH:2,NJ:12,NM:3,NY:26,NC:14,ND:1,OH:15,OK:5,OR:6,PA:17,RI:2,SC:7,SD:1,TN:9,TX:38,UT:4,VT:1,VA:11,WA:10,WV:2,WI:8,WY:1 };
export const GOV_STATES = ['AL','AK','AZ','AR','CA','CO','CT','FL','GA','HI','ID','IL','IA','KS','ME','MD','MA','MI','MN','NE','NV','NH','NM','NY','OH','OK','OR','PA','RI','SC','SD','TN','TX','VT','WI','WY'];

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function strHash(s) { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; }

function region(key, name, lean, progress, size, singleCandidate) {
  const r = rng(strHash(key));
  const dShare = Math.min(0.85, Math.max(0.15, 0.5 + lean + (r() - 0.5) * 0.06));
  const turnout = Math.round(size * (0.8 + r() * 0.4));
  const start = r() * 0.35; // stagger when counting begins
  const p = Math.max(0, Math.min(1, (progress - start) / (1 - start)));
  const counted = Math.round(turnout * p);
  const drift = (r() - 0.5) * 0.08 * (1 - p); // early counts wobble, which produces lead changes
  const d = Math.round(counted * Math.min(0.98, Math.max(0.02, dShare + drift)));
  const third = singleCandidate ? 0 : Math.round(counted * 0.015);
  const rep = singleCandidate ? 0 : counted - d - third;
  const pct = Math.round(p * 1000) / 10;
  const margin = counted ? Math.abs(d - rep) / counted : 0;
  const call = !singleCandidate && pct >= 70 && margin > 0.06 + (1 - p) * 0.1;
  const mk = (id, nm, party, votes, inc) => ({ name: nm, candidate_id: id, party, votes, percent: counted ? Math.round(votes / counted * 1000) / 10 : 0,
    winner: false, advanced: false, incumbent: inc, major_candidate: true, color: '' });
  const cands = singleCandidate
    ? [mk(`${key}-d`, `Sample Candidate ${key.toUpperCase()}-A`, 'Democratic', 0, true)]
    : [mk(`${key}-d`, `Sample Candidate ${key.toUpperCase()}-A`, 'Democratic', d, lean > 0.05),
       mk(`${key}-r`, `Sample Candidate ${key.toUpperCase()}-B`, 'Republican', rep, lean < -0.05),
       mk(`${key}-i`, `Sample Candidate ${key.toUpperCase()}-C`, 'Libertarian', third, false)];
  if (call) { const top = cands.slice().sort((a, b) => b.votes - a.votes)[0]; top.winner = true; }
  return { name, type: 'district', fill: '', election_id: 900000 + (strHash(key) % 99999), percent_reporting: pct, candidates: cands };
}

const LEAN = s => ((strHash(s) % 1000) / 1000 - 0.5) * 0.5;

export function createSampleAdapter(source, {
  minutesToFull = Number(process.env.LIVEDESK_SAMPLE_MINUTES || 30),
  startedAt = Date.now() - Number(process.env.LIVEDESK_SAMPLE_START || 0) * minutesToFull * 60000
} = {}) {
  return {
    id: source.id,
    describe: () => ({ kind: 'sample', license: 'Simulated. Not real election results.' }),
    async fetch() {
      const fetchedAt = new Date().toISOString();
      const progress = Math.min(1, (Date.now() - startedAt) / (minutesToFull * 60000));
      const meta = { last_updated: fetchedAt, test_data: false };
      const contests = [];
      const push = (office, key, nm, lean, size, single = false) => {
        const c = normalizeRegion({ office, key, region: region(`${office}-${key}`, nm, lean, progress, size, single), raceMeta: meta, sourceUrl: 'sample://civicapi-shape', fetchedAt });
        c.flags.push('sample-data'); c.provenance = { ...c.provenance, sourceId: source.id, sourceName: 'Sample data (simulated)', humanUrl: null };
        if (c.call.status === 'projected') c.call.by = 'Sample data (simulated)';
        contests.push(c);
      };
      const senate = Object.keys(source.params?.senateStates || {}).length ? source.params.senateStates : null;
      for (const st of senate || ['AL','AK','AR','CO','DE','FL','GA','ID','IL','IA','KS','KY','LA','ME','MA','MI','MN','MS','MT','NE','NH','NJ','NM','NC','OH','OK','OR','RI','SC','SD','TN','TX','VA','WV','WY'])
        push('us_senate', st.toLowerCase(), st, LEAN(st), 2_000_000);
      for (const st of GOV_STATES) push('governor', st.toLowerCase(), st, LEAN(st) + 0.03, 2_000_000);
      for (const [st, n] of Object.entries(HOUSE_SEATS))
        for (let i = 1; i <= n; i++) {
          const key = n === 1 ? `${st.toLowerCase()}-al` : `${st.toLowerCase()}-${String(i).padStart(2, '0')}`;
          push('us_house', key, key.toUpperCase(), LEAN(key) * 1.6, 300_000, strHash(key) % 40 === 0);
        }
      return { contests, meta: { holdover: { us_senate: { DEM: 34, REP: 31 }, governor: { DEM: 6, REP: 8 } }, sample: true, progress } };
    }
  };
}
