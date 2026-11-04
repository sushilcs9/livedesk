import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegion } from '../server/core/adapters/civicapi.js';
import { reconcile } from '../server/core/reconcile.js';
import { summarize, describeChange } from '../server/modules/elections/index.js';
import { openStore } from '../server/core/store.js';
import { createEngine } from '../server/core/engine.js';
import { createHttp } from '../server/http/server.js';
import { readFileSync } from 'node:fs';
import { HOUSE_SEATS } from '../server/core/adapters/sample.js';

const RULES = { countsHeldBefore: '2026-11-03T23:00:00Z', discrepancyTolerancePct: 0.5, closeRace: { veryCloseMarginPts: 1, competitiveMarginPts: 5, minReportingPct: 1 }, notableReportingJumpPts: 10 };
const AFTER = Date.parse('2026-11-04T03:00:00Z');
const meta = { last_updated: '2026-11-04T02:59:00Z', test_data: false };
const region = (votes, winner = null, pr = 80) => ({ name: 'Georgia', election_id: 86920, percent_reporting: pr, candidates: [
  { name: 'Alice Able', candidate_id: 1, party: 'Democratic', votes: votes[0], percent: 0, winner: winner === 0, incumbent: true },
  { name: 'Bob Baker', candidate_id: 2, party: 'Republican', votes: votes[1], percent: 0, winner: winner === 1, incumbent: false }] });
const obs = (sourceId, r, office = 'us_senate', key = 'ga') => ({ sourceId, contest: { ...normalizeRegion({ office, key, region: r, raceMeta: meta, sourceUrl: 'u', fetchedAt: 'f' }), provenance: { sourceId, sourceName: sourceId } } });
const SRC = { civicapi: { priority: 50, enabled: true }, official: { priority: 100, enabled: true } };

test('civicAPI region keys map to stable contest ids', () => {
  assert.equal(obs('civicapi', region([1, 2]), 'us_house', 'ca-22').contest.id, 'us_house:CA-22');
  assert.equal(obs('civicapi', region([1, 2]), 'us_house', 'ak-al').contest.id, 'us_house:AK-AL');
  assert.equal(obs('civicapi', region([1, 2])).contest.id, 'us_senate:GA');
  const c = obs('civicapi', region([1, 2], 0)).contest;
  assert.equal(c.call.status, 'projected'); assert.equal(c.call.by, 'civicAPI');
  assert.match(c.reporting.definition, /does not state whether/);
});

test('apportionment in sample data totals 435', () => {
  assert.equal(Object.values(HOUSE_SEATS).reduce((a, b) => a + b, 0), 435);
});

test('leading is never winning', () => {
  const c = reconcile({ observations: [obs('civicapi', region([600000, 400000]))], sourcesById: SRC, healthById: {}, rules: RULES, now: AFTER });
  assert.equal(c.status, 'counting'); assert.equal(c.decided, false); assert.equal(c.leader.name, 'Alice Able');
  assert.ok(!c.candidates.some(x => x.winner));
  assert.equal(c.margin.votes, 200000); assert.equal(c.margin.pts, 20);
});

test('counts are held before polls close and when they exceed population', () => {
  const early = reconcile({ observations: [obs('civicapi', region([10, 5]))], sourcesById: SRC, healthById: {}, rules: RULES, now: Date.parse('2026-11-03T20:00:00Z') });
  assert.equal(early.status, 'held'); assert.equal(early.candidates[0].votes, null);
  const huge = reconcile({ observations: [obs('civicapi', region([8_600_000, 8_600_000], 0))], sourcesById: SRC, healthById: {}, rules: RULES, now: AFTER });
  assert.ok(huge.flags.includes('held:votes-exceed-population')); assert.equal(huge.decided, false);
});

test('highest-priority source supplies counts; no double counting; discrepancies listed', () => {
  const c = reconcile({ observations: [obs('civicapi', region([500000, 400000])), obs('official', region([510000, 400000]))], sourcesById: SRC, healthById: {}, rules: RULES, now: AFTER });
  assert.equal(c.totalVotes, 910000);
  assert.equal(c.sources.find(s => s.primary).id, 'official');
  assert.equal(c.discrepancies.length, 1);
});

test('failover when the primary source is down', () => {
  const c = reconcile({ observations: [obs('civicapi', region([500000, 400000])), obs('official', region([510000, 400000]))], sourcesById: SRC, healthById: { official: { status: 'down' } }, rules: RULES, now: AFTER });
  assert.equal(c.sources.find(s => s.primary).id, 'civicapi'); assert.equal(c.totalVotes, 900000);
});

test('conflicting calls show no winner', () => {
  const c = reconcile({ observations: [obs('civicapi', region([500000, 400000], 0)), obs('official', region([500000, 400000], 1))], sourcesById: SRC, healthById: {}, rules: RULES, now: AFTER });
  assert.equal(c.status, 'conflict'); assert.ok(!c.candidates.some(x => x.winner));
});

test('withdrawn calls are marked retracted', () => {
  const called = reconcile({ observations: [obs('civicapi', region([500000, 400000], 0))], sourcesById: SRC, healthById: {}, rules: RULES, now: AFTER });
  assert.equal(called.status, 'projected');
  const after = reconcile({ observations: [obs('civicapi', region([500000, 490000]))], sourcesById: SRC, healthById: {}, previous: called, rules: RULES, now: AFTER });
  assert.equal(after.call.status, 'retracted'); assert.deepEqual(after.call.previousWinners, ['Alice Able']); assert.equal(after.decided, false);
  const items = describeChange(called, after, RULES);
  assert.ok(items.some(i => i.kind === 'retraction'));
});

test('editor override wins and is attributed', () => {
  const c = reconcile({ observations: [obs('civicapi', region([500000, 400000]))], sourcesById: SRC, healthById: {}, rules: RULES, now: AFTER,
    override: { call: { status: 'certified', winnerIds: ['1'], by: 'Georgia Secretary of State', sourceUrl: 'https://sos.ga.gov' }, actor: 'ed', at: 'x' } });
  assert.equal(c.status, 'certified'); assert.equal(c.call.editorial, true); assert.equal(c.candidates.find(x => x.winner).name, 'Alice Able');
});

test('chamber control requires called seats to reach the majority', () => {
  const ev = { rules: { ...RULES, chambers: { us_senate: { label: 'Senate', total: 100, majority: 51, holdover: { DEM: 34, REP: 31 } } }, seatHistory: { us_senate: { GA: 'DEM' } } } };
  const ga = reconcile({ observations: [obs('civicapi', region([400000, 500000], 1))], sourcesById: SRC, healthById: {}, rules: RULES, now: AFTER });
  const s = summarize(ev, [ga]);
  assert.equal(s.chambers.us_senate.seats.REP, 32); assert.equal(s.chambers.us_senate.control, null);
  assert.deepEqual(s.chambers.us_senate.netChange, { REP: 1, DEM: -1 });
  // A source tally that already includes the call must not be added again.
  const s2 = summarize(ev, [ga], { holdover: { us_senate: { DEM: 34, REP: 32 } } });
  assert.equal(s2.chambers.us_senate.seats.REP, 32); assert.equal(s2.chambers.us_senate.seats.DEM, 34);
});

test('HTTP: public API, admin RBAC, manual call needs a source, audit log', async () => {
  const store = openStore(':memory:');
  const cfg = JSON.parse(readFileSync(new URL('../config/events/us-2026-general.json', import.meta.url)));
  cfg.sources = [{ id: 'sample', adapter: 'sample', name: 'Sample', enabled: true, priority: 1, intervalSec: 3600, params: {} }];
  store.upsertEvent(cfg);
  const engine = createEngine(store, { sampleMode: true });
  await engine.runOnce(cfg, cfg.sources[0]);
  const server = createHttp({ store, engine, publicDir: new URL('../public', import.meta.url).pathname, adminUsers: 'ed:editor:edtok,ad:admin:adtok' });
  await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(`${base}/api/events/us-2026-general/contests?office=us_senate`)).json();
    assert.equal(list.total, 35);
    const cid = encodeURIComponent('us_senate:GA');
    const one = await (await fetch(`${base}/api/events/us-2026-general/contests/${cid}`)).json();
    const winner = one.contest.candidates[0].id;
    let r = await fetch(`${base}/api/admin/events/us-2026-general/contests/${cid}/override`, { method: 'POST', body: JSON.stringify({ call: { status: 'projected', winnerIds: [winner] } }) });
    assert.equal(r.status, 401);
    r = await fetch(`${base}/api/admin/events/us-2026-general/contests/${cid}/override`, { method: 'POST', headers: { Authorization: 'Bearer edtok' }, body: JSON.stringify({ call: { status: 'projected', winnerIds: [winner] } }) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/admin/events/us-2026-general/contests/${cid}/override`, { method: 'POST', headers: { Authorization: 'Bearer edtok' }, body: JSON.stringify({ call: { status: 'projected', winnerIds: [winner], by: 'Test Desk', sourceUrl: 'https://example.org/call' } }) });
    assert.equal(r.status, 200); assert.equal((await r.json()).contest.status, 'projected');
    r = await fetch(`${base}/api/admin/events/us-2026-general/sources/sample`, { method: 'PATCH', headers: { Authorization: 'Bearer edtok' }, body: '{"intervalSec":30}' });
    assert.equal(r.status, 401, 'editors cannot change sources');
    const audit = await (await fetch(`${base}/api/admin/audit`, { headers: { Authorization: 'Bearer adtok' } })).json();
    assert.equal(audit[0].action, 'override.set'); assert.equal(audit[0].actor, 'ed');
    const feed = await (await fetch(`${base}/api/events/us-2026-general/feed?contest=us_senate:GA`)).json();
    assert.ok(feed.some(f => f.kind === 'call' && f.source === 'Test Desk'));
  } finally { engine.stop(); server.close(); }
});
