// Canonical result format shared by every adapter and every event module.
//
// Contest {
//   id            stable key, e.g. "us_senate:GA", "us_house:CA-22", "governor:PA", "ballot_measure:CA-PROP-1"
//   eventId
//   office        machine code (us_senate | us_house | governor | state_senate | state_house | ballot_measure | local | other)
//   officeLabel   human label from the source
//   level         federal | state | local
//   jurisdiction  { country, state, district|null, name }
//   kind          candidate | measure
//   candidates    [{ id, name, party, partyLabel, incumbent, votes|null, pct|null, winner, advanced }]
//   totalVotes    number|null
//   reporting     { value|null, label, definition }   — the source's own metric, never re-labelled
//   call          { status: none|projected|certified|retracted|conflict, winnerIds, by, at, sourceUrl, note }
//   regions       optional sub-geography rows [{ key, name, type, reporting, candidates }]
//   provenance    { sourceId, sourceName, url, fetchedAt, sourceUpdatedAt, license }
//   flags         [ "held:before-polls-close", "sample-data", ... ]
// }
//
// Adapters return raw observations in this shape. reconcile.js merges observations from
// several sources into the published contest and adds: status, leader, margin, sources[], discrepancies[].

export const OFFICE_LABELS = {
  us_senate: 'U.S. Senate', us_house: 'U.S. House', governor: 'Governor', lt_governor: 'Lieutenant Governor',
  attorney_general: 'Attorney General', secretary_of_state: 'Secretary of State', state_senate: 'State Senate',
  state_house: 'State House', ballot_measure: 'Ballot measure', mayor: 'Mayor', local: 'Local', other: 'Other office'
};

export function contestId(office, state, district = null, suffix = null) {
  let id = `${office}:${state}`;
  if (district != null && district !== '') id += `-${String(district).toUpperCase()}`;
  if (suffix) id += `:${suffix}`;
  return id;
}

/** Derived fields that depend only on the contest's own numbers. Never invents a winner. */
export function derive(contest) {
  const c = structuredClone(contest);
  const withVotes = c.candidates.filter(x => typeof x.votes === 'number');
  const total = withVotes.reduce((s, x) => s + x.votes, 0);
  c.totalVotes = withVotes.length ? total : null;
  for (const cand of c.candidates) {
    if (typeof cand.votes === 'number' && total > 0) cand.pct = Math.round((cand.votes / total) * 10000) / 100;
    else if (cand.pct == null) cand.pct = null;
  }
  c.candidates.sort((a, b) => (b.votes ?? -1) - (a.votes ?? -1) || a.name.localeCompare(b.name));
  const [first, second] = c.candidates;
  if (total > 0 && first && first.votes > 0) {
    c.leader = { id: first.id, name: first.name, party: first.party };
    if (second && typeof second.votes === 'number') {
      c.margin = { votes: first.votes - second.votes, pts: Math.round((first.pct - second.pct) * 100) / 100, tied: first.votes === second.votes };
      if (c.margin.tied) c.leader = null;
    } else c.margin = null;
  } else { c.leader = null; c.margin = null; }

  c.uncontested = c.kind !== 'measure' && c.candidates.length === 1;
  const callStatus = c.call?.status ?? 'none';
  if (c.flags?.some(f => f.startsWith('held:'))) c.status = 'held';
  else if (callStatus === 'certified') c.status = 'certified';
  else if (callStatus === 'projected') c.status = 'projected';
  else if (callStatus === 'conflict') c.status = 'conflict';
  else if (total > 0) c.status = 'counting';
  else if (c.uncontested) c.status = 'uncontested';
  else c.status = 'no_results';
  c.decided = c.status === 'projected' || c.status === 'certified';
  return c;
}
