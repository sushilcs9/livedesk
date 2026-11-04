// Merges observations of one contest from several sources into the published contest.
// Rules (documented on the Methodology page):
//  1. Sources are ranked by configured priority (official > wire > aggregator by default).
//     The highest-priority healthy source that has vote data supplies the counts. Counts are never
//     summed across sources, so votes cannot be double-counted.
//  2. Other sources are compared; differences above the tolerance are listed as discrepancies.
//  3. A winner is shown only when a source explicitly calls the race. Leading is never winning.
//     If two sources call different winners the contest shows "conflicting calls" and no winner.
//  4. If a previously called race loses its call, the contest is marked "retracted" until re-called.
//  5. Sanity guards hold implausible counts (see validate()). Held counts are not displayed.
//  6. An administrator override (call, certification, hold, note) always wins and is audited.
import { derive } from './contest.js';

const STATE_POP_2020 = { AL:5024279,AK:733391,AZ:7151502,AR:3011524,CA:39538223,CO:5773714,CT:3605944,DE:989948,DC:689545,FL:21538187,GA:10711908,HI:1455271,ID:1839106,IL:12812508,IN:6785528,IA:3190369,KS:2937880,KY:4505836,LA:4657757,ME:1362359,MD:6177224,MA:7029917,MI:10077331,MN:5706494,MS:2961279,MO:6154913,MT:1084225,NE:1961504,NV:3104614,NH:1377529,NJ:9288994,NM:2117522,NY:20201249,NC:10439388,ND:779094,OH:11799448,OK:3959353,OR:4237256,PA:13002700,RI:1097379,SC:5118425,SD:886667,TN:6910840,TX:29145505,UT:3271616,VT:643077,VA:8631393,WA:7705281,WV:1793716,WI:5893718,WY:576851 };
const MAX_DISTRICT_VOTES = 1_000_000; // largest 2020 district population is ~990k (Delaware at-large)

export function validate(c, rules, now = Date.now()) {
  const flags = [...(c.flags || [])];
  const total = c.candidates.reduce((s, x) => s + (x.votes || 0), 0);
  if (rules.countsHeldBefore && now < Date.parse(rules.countsHeldBefore) && total > 0) flags.push('held:before-polls-close');
  const cap = c.office === 'us_house' ? MAX_DISTRICT_VOTES : STATE_POP_2020[c.jurisdiction.state];
  if (cap && total > cap) flags.push('held:votes-exceed-population');
  if (c.candidates.some(x => x.votes != null && x.votes < 0)) flags.push('held:negative-votes');
  if (c.reporting?.value != null && (c.reporting.value < 0 || c.reporting.value > 100)) flags.push('held:reporting-out-of-range');
  return [...new Set(flags)];
}

function candidateKey(c) { return c.name.toLowerCase().replace(/[^a-z]/g, ''); }

export function reconcile({ observations, sourcesById, healthById, override, previous, rules, now = Date.now() }) {
  const ranked = observations
    .filter(o => sourcesById[o.sourceId]?.enabled !== false)
    .map(o => ({ ...o, priority: sourcesById[o.sourceId]?.priority ?? 0, down: healthById[o.sourceId]?.status === 'down' }))
    .sort((a, b) => (a.down - b.down) || (b.priority - a.priority));
  if (!ranked.length) return null;

  const hasVotes = o => o.contest.candidates.some(c => (c.votes || 0) > 0);
  const primary = ranked.find(o => !o.down && hasVotes(o)) || ranked.find(o => !o.down) || ranked[0];
  const base = structuredClone(primary.contest);
  base.flags = validate(base, rules, now);

  // Holding: keep candidate list, blank out counts so nothing implausible is shown.
  if (base.flags.some(f => f.startsWith('held:'))) {
    base.heldCounts = true;
    for (const cand of base.candidates) { cand.votes = null; cand.pct = null; cand.winner = false; }
    base.call = { status: 'none', winnerIds: [] };
  }

  // Discrepancies between sources.
  const tolerance = (rules.discrepancyTolerancePct ?? 0.5) / 100;
  const discrepancies = [];
  for (const o of ranked) {
    if (o === primary || !hasVotes(o)) continue;
    const other = new Map(o.contest.candidates.map(c => [candidateKey(c), c]));
    for (const c of primary.contest.candidates) {
      const oc = other.get(candidateKey(c));
      if (!oc || c.votes == null || oc.votes == null) continue;
      const diff = Math.abs(c.votes - oc.votes);
      if (diff > Math.max(50, tolerance * Math.max(c.votes, oc.votes)))
        discrepancies.push({ candidate: c.name, primary: { source: primary.sourceId, votes: c.votes }, other: { source: o.sourceId, votes: oc.votes } });
    }
  }

  // Calls: collect explicit calls from every non-held source.
  const calls = ranked.filter(o => o.contest.call?.status === 'projected' || o.contest.call?.status === 'certified')
    .map(o => ({ source: o.sourceId, by: o.contest.call.by, winners: o.contest.call.winnerIds.map(id => o.contest.candidates.find(c => c.id === id)?.name).filter(Boolean), call: o.contest.call }));
  if (!base.heldCounts && calls.length) {
    const distinct = new Set(calls.map(c => c.winners.map(n => n.toLowerCase()).sort().join('|')));
    if (distinct.size > 1) {
      base.call = { status: 'conflict', winnerIds: [], by: calls.map(c => c.by).join(' vs '), calls, note: 'Sources disagree on the winner. No winner is shown until they agree or an editor resolves it.' };
      for (const cand of base.candidates) cand.winner = false;
    } else {
      const best = calls[0]; // ranked order => highest-priority caller
      const names = new Set(best.winners.map(n => n.toLowerCase()));
      base.call = { ...best.call, winnerIds: base.candidates.filter(c => names.has(c.name.toLowerCase())).map(c => c.id), alsoCalledBy: calls.slice(1).map(c => c.by) };
      for (const cand of base.candidates) cand.winner = names.has(cand.name.toLowerCase());
    }
  } else if (!base.heldCounts && previous && ['projected', 'retracted'].includes(previous.call?.status) && previous.call.status !== 'certified') {
    base.call = { status: 'retracted', winnerIds: [], by: previous.call.by, at: previous.call.status === 'retracted' ? previous.call.at : new Date(now).toISOString(),
      previousWinners: previous.call.previousWinners || previous.candidates.filter(c => c.winner).map(c => c.name),
      note: 'A previous race call was withdrawn by its source.' };
  }

  // Editorial override.
  if (override) {
    base.override = { actor: override.actor, at: override.at, note: override.note ?? null };
    if (override.hold) { base.flags.push('held:editor'); base.heldCounts = true; for (const c of base.candidates) { c.votes = null; c.pct = null; c.winner = false; } base.call = { status: 'none', winnerIds: [] }; }
    if (override.call) {
      const ids = new Set(override.call.winnerIds || []);
      base.call = { status: override.call.status, winnerIds: [...ids], by: override.call.by || 'Editor', at: override.at, sourceUrl: override.call.sourceUrl ?? null, note: override.note ?? null, editorial: true };
      for (const c of base.candidates) c.winner = ids.has(c.id);
    }
  }

  base.sources = ranked.map(o => ({ id: o.sourceId, name: o.contest.provenance?.sourceName, priority: o.priority, primary: o === primary,
    down: o.down, url: o.contest.provenance?.humanUrl || o.contest.provenance?.url, fetchedAt: o.contest.provenance?.fetchedAt, sourceUpdatedAt: o.contest.provenance?.sourceUpdatedAt }));
  base.discrepancies = discrepancies;
  return derive(base);
}
