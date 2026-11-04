// Elections module: reporting rules specific to elections (chamber balance, close races, feed
// triggers, map colouring). Other event categories (economics, sports) register their own module
// with the same three functions: describeChange, summarize, labels.
import { OFFICE_LABELS } from '../../core/contest.js';

const PARTY_NAME = { DEM: 'Democrat', REP: 'Republican', IND: 'Independent', LIB: 'Libertarian', GRN: 'Green', OTH: 'Other', YES: 'Yes', NO: 'No' };
const label = c => `${c.officeLabel === OFFICE_LABELS[c.office] ? OFFICE_LABELS[c.office] : c.officeLabel} · ${c.jurisdiction.district ? `${c.jurisdiction.state}-${c.jurisdiction.district}` : c.jurisdiction.name}`;
const cand = c => c ? `${c.name} (${c.party === 'OTH' ? c.partyLabel : c.party.charAt(0)})` : '';

/** Feed items produced when a published contest changes. Each names its source and time. */
export function describeChange(prev, next, rules) {
  const items = [];
  const src = next.sources?.find(s => s.primary);
  const base = { contestId: next.id, source: src?.name ?? null, sourceUrl: src?.url ?? null, reportedAt: src?.sourceUpdatedAt ?? src?.fetchedAt ?? null };
  const prevVotes = prev?.totalVotes ?? 0;

  if (next.call?.status !== prev?.call?.status || String(next.call?.winnerIds) !== String(prev?.call?.winnerIds)) {
    const winners = next.candidates.filter(c => c.winner);
    if (next.call.status === 'projected' || next.call.status === 'certified') {
      const verb = next.call.status === 'certified' ? 'Certified' : 'Projected winner';
      items.push({ ...base, kind: next.call.status === 'certified' ? 'certified' : 'call', source: next.call.by,
        title: `${verb}: ${winners.map(cand).join(', ')} — ${label(next)}`, detail: { by: next.call.by, editorial: !!next.call.editorial, party: winners[0]?.party } });
    } else if (next.call.status === 'retracted') {
      items.push({ ...base, kind: 'retraction', source: next.call.by, title: `Race call withdrawn — ${label(next)}`, detail: { previousWinners: next.call.previousWinners } });
    } else if (next.call.status === 'conflict') {
      items.push({ ...base, kind: 'conflict', title: `Sources disagree on the winner — ${label(next)}`, detail: { calls: next.call.calls } });
    }
  }
  if (!prev?.heldCounts && next.heldCounts && next.flags.some(f => f !== 'held:before-polls-close' && f.startsWith('held:')))
    items.push({ ...base, kind: 'held', title: `Counts held after a data check — ${label(next)}`, detail: { flags: next.flags } });

  if (!next.heldCounts && prevVotes === 0 && (next.totalVotes ?? 0) > 0)
    items.push({ ...base, kind: 'first-results', title: `First results reported — ${label(next)}`, detail: { reporting: next.reporting?.label } });

  if (!next.decided && prev?.leader && next.leader && prev.leader.name !== next.leader.name && (prev.totalVotes ?? 0) > 0)
    items.push({ ...base, kind: 'lead-change', title: `Lead change: ${cand(next.candidates[0])} moves ahead — ${label(next)}`,
      detail: { from: prev.leader.name, to: next.leader.name, marginPts: next.margin?.pts } });

  const pr = prev?.reporting?.value ?? 0, nr = next.reporting?.value ?? 0;
  const jump = rules.notableReportingJumpPts ?? 10;
  // Count updates only for statewide races and close races, so the feed is not flooded by 435 districts.
  const notable = ['us_senate', 'governor'].includes(next.office) || closeness(next, rules);
  if (notable && !next.heldCounts && Math.floor(nr / jump) > Math.floor(pr / jump) && nr < 100 && prevVotes > 0)
    items.push({ ...base, kind: 'count-update', title: `${next.reporting.label} — ${label(next)}`, detail: { leader: next.leader?.name, marginPts: next.margin?.pts } });

  if ((next.discrepancies?.length ?? 0) > 0 && !(prev?.discrepancies?.length))
    items.push({ ...base, kind: 'discrepancy', title: `Sources report different counts — ${label(next)}`, detail: { discrepancies: next.discrepancies } });
  return items;
}

export function closeness(c, rules) {
  const cr = rules.closeRace || {};
  if (c.decided || c.heldCounts || !c.margin || (c.reporting?.value ?? 0) < (cr.minReportingPct ?? 1)) return null;
  if (Math.abs(c.margin.pts) <= (cr.veryCloseMarginPts ?? 1)) return 'very-close';
  if (Math.abs(c.margin.pts) <= (cr.competitiveMarginPts ?? 5)) return 'competitive';
  return null;
}

/** National overview: chamber balance, races called and remaining, close races. */
export function summarize(event, contests, sourceMeta = {}) {
  const rules = event.rules || {};
  const chambers = {};
  for (const [office, ch] of Object.entries(rules.chambers || {})) {
    const races = contests.filter(c => c.office === office);
    const holdover = { ...(ch.holdover || {}) }; delete holdover._note;
    // civicAPI's party "seats" figure is its own running tally (seats not up PLUS races it has called),
    // so it must never be added to our called races. Seats not up come from the event config only;
    // the source's tally is passed through for comparison.
    const srcTally = sourceMeta.holdover?.[office] ?? null;
    const usedHoldover = holdover;
    const won = {}, leading = {}, flips = [];
    for (const c of races) {
      if (c.decided) {
        const w = c.candidates.find(x => x.winner);
        if (w) {
          won[w.party] = (won[w.party] || 0) + 1;
          const prior = rules.seatHistory?.[office]?.[c.jurisdiction.state];
          if (prior && prior !== w.party) flips.push({ contestId: c.id, from: prior, to: w.party, winner: w.name });
        }
      } else if (c.leader && !c.heldCounts) leading[c.leader.party] = (leading[c.leader.party] || 0) + 1;
    }
    const seats = {};
    for (const p of new Set([...Object.keys(usedHoldover), ...Object.keys(won)])) seats[p] = (usedHoldover[p] || 0) + (won[p] || 0);
    let control = null;
    if (ch.majority) for (const [p, n] of Object.entries(seats)) if (n >= ch.majority) control = { party: p, seats: n, basis: 'Seats held plus races called by a named source.' };
    const net = {};
    const priorMap = rules.seatHistory?.[office];
    if (priorMap) for (const f of flips) { net[f.to] = (net[f.to] || 0) + 1; net[f.from] = (net[f.from] || 0) - 1; }
    chambers[office] = {
      label: ch.label, total: ch.total, majority: ch.majority, tieNote: ch.tieNote ?? null,
      racesUp: races.length, called: races.filter(c => c.decided).length, undecided: races.filter(c => !c.decided).length,
      holdover: usedHoldover, holdoverSource: 'config', sourceTally: srcTally, won, seats, leading, control,
      netChange: priorMap ? net : null, flips,
      netChangeNote: priorMap ? 'Compared with the party (by caucus) holding each seat before the election.' : 'Net change is not computed for this chamber yet: it needs a verified list of which party held each seat before the election.'
    };
  }
  const close = contests.map(c => ({ c, level: closeness(c, rules) })).filter(x => x.level)
    .sort((a, b) => Math.abs(a.c.margin.pts) - Math.abs(b.c.margin.pts)).slice(0, 25)
    .map(({ c, level }) => ({ id: c.id, label: label(c), level, leader: c.leader, marginPts: c.margin.pts, marginVotes: c.margin.votes, reporting: c.reporting }));
  const counts = { total: contests.length, called: 0, counting: 0, no_results: 0, held: 0, uncontested: 0, certified: 0, conflict: 0, projected: 0 };
  for (const c of contests) counts[c.status] = (counts[c.status] || 0) + 1;
  counts.called = counts.projected + counts.certified;
  const states = {};
  for (const c of contests) {
    const s = (states[c.jurisdiction.state] ||= { races: 0, called: 0, counting: 0, offices: {} });
    s.races++; if (c.decided) s.called++; if (c.status === 'counting') s.counting++;
    if (c.office === 'us_senate' || c.office === 'governor') s.offices[c.office] = mapCell(c);
    if (c.office === 'us_house') {
      const h = (s.offices.us_house ||= { seats: 0, won: {}, leading: {} });
      h.seats++;
      if (c.decided) { const w = c.candidates.find(x => x.winner); if (w) h.won[w.party] = (h.won[w.party] || 0) + 1; }
      else if (c.leader) h.leading[c.leader.party] = (h.leading[c.leader.party] || 0) + 1;
    }
  }
  return { chambers, counts, close, states, partyNames: PARTY_NAME };
}

function mapCell(c) {
  const w = c.candidates.find(x => x.winner);
  return { id: c.id, status: c.status, party: w?.party ?? c.leader?.party ?? null, decided: c.decided, winner: w?.name ?? null,
    leader: c.leader?.name ?? null, marginPts: c.margin?.pts ?? null, reporting: c.reporting?.label ?? null };
}
