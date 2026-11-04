// Ingestion engine: one scheduler per (event, source). Workers only talk to providers; viewers only
// talk to our cache. That separation is what keeps election-night traffic away from data providers.
import { EventEmitter } from 'node:events';
import { createAdapter } from './adapters/index.js';
import { reconcile } from './reconcile.js';
import { hashOf, log, nowIso } from './util.js';
import * as elections from '../modules/elections/index.js';

export const MODULES = { elections };

export function createEngine(store, { sampleMode = false } = {}) {
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const runners = new Map(); // `${eventId}/${sourceId}` -> runner
  const sourceMeta = new Map(); // eventId -> merged adapter meta (holdover etc.)
  const summaries = new Map(); // eventId -> { json, etag }
  const contestCache = new Map(); // eventId -> Map(contestId -> contest)
  const adapters = new Map();

  function moduleFor(ev) { return MODULES[ev.module] || elections; }
  function contestsOf(eventId) {
    if (!contestCache.has(eventId)) contestCache.set(eventId, new Map(store.listContests(eventId).map(c => [c.id, c])));
    return contestCache.get(eventId);
  }

  function health(eventId, sourceId) { return store.getHealth(eventId, sourceId) || { status: 'idle', failures: 0 }; }

  function recompute(ev, contestIds) {
    const sourcesById = Object.fromEntries(ev.sources.map(s => [s.id, s]));
    const healthById = Object.fromEntries(ev.sources.map(s => [s.id, health(ev.id, s.id)]));
    const mod = moduleFor(ev); const cache = contestsOf(ev.id); const changed = [];
    for (const cid of contestIds) {
      const prev = cache.get(cid) || null;
      const next = reconcile({ observations: store.observationsFor(ev.id, cid), sourcesById, healthById,
        override: store.activeOverride(ev.id, cid), previous: prev, rules: ev.rules || {} });
      if (!next) continue;
      next.eventId = ev.id;
      const { sources, provenance, ...hashable } = next; // fetch timestamps alone should not count as a change
      const h = hashOf({ ...hashable, s: sources.map(s => s.id + s.primary + s.down) });
      if (prev && prev._hash === h) continue;
      next._hash = h; next.updatedAt = nowIso();
      store.putContest(ev.id, next, h); cache.set(cid, next); changed.push(next);
      for (const item of mod.describeChange(prev, next, ev.rules || {})) emitFeed(ev, item);
    }
    if (changed.length) {
      const before = summaries.get(ev.id)?.data;
      const s = refreshSummary(ev);
      for (const [office, ch] of Object.entries(s.chambers || {}))
        if (ch.control && before?.chambers?.[office]?.control?.party !== ch.control.party)
          emitFeed(ev, { kind: 'control', title: `${ch.label}: ${s.partyNames[ch.control.party] || ch.control.party}s reach ${ch.control.seats} seats, a majority, based on called races`, source: 'Calculated from called races', detail: ch.control });
      bus.emit(`contests:${ev.id}`, changed);
    }
    return changed;
  }

  function emitFeed(ev, item) {
    const saved = store.addFeed({ ...item, eventId: ev.id, at: nowIso() });
    bus.emit(`feed:${ev.id}`, saved);
  }

  function refreshSummary(ev) {
    const data = { ...moduleFor(ev).summarize(ev, [...contestsOf(ev.id).values()], sourceMeta.get(ev.id) || {}),
      generatedAt: nowIso(), sample: sampleMode, sourcesStatus: ev.sources.map(s => ({ id: s.id, name: s.name, enabled: s.enabled, trust: s.trust, priority: s.priority, license: s.license, homepage: s.homepage, intervalSec: s.intervalSec, health: health(ev.id, s.id) })) };
    summaries.set(ev.id, { data, etag: `"${hashOf(data)}"` });
    bus.emit(`summary:${ev.id}`, data);
    return data;
  }

  async function runOnce(ev, source) {
    const key = `${ev.id}/${source.id}`;
    let adapter = adapters.get(key);
    if (!adapter) { adapter = createAdapter(source); adapters.set(key, adapter); }
    const h = health(ev.id, source.id);
    const t0 = Date.now();
    try {
      const { contests, meta } = await adapter.fetch();
      const touched = [];
      for (const c of contests) if (store.putObservation(ev.id, source.id, c.id, hashOf({ ...c, provenance: { ...c.provenance, fetchedAt: null } }), c)) touched.push(c.id);
      if (meta?.holdover) sourceMeta.set(ev.id, { ...(sourceMeta.get(ev.id) || {}), holdover: { ...(sourceMeta.get(ev.id)?.holdover || {}), ...meta.holdover } });
      const partial = meta?.partialErrors?.length ? meta.partialErrors : null;
      store.setHealth(ev.id, source.id, { status: partial ? 'partial' : 'ok', failures: 0, lastSuccess: nowIso(), lastAttempt: nowIso(), latencyMs: Date.now() - t0, contests: contests.length, changed: touched.length, lastError: partial ? `${nowIso()} ${partial.join('; ')}` : (h.lastError ?? null) });
      const changed = recompute(ev, touched);
      if (!touched.length) refreshSummary(ev);
      log('info', 'ingest', { event: ev.id, source: source.id, contests: contests.length, observationsChanged: touched.length, published: changed.length, ms: Date.now() - t0 });
      return { ok: true };
    } catch (e) {
      const failures = (h.failures || 0) + 1;
      const status = e.permanent ? 'misconfigured' : failures >= 3 ? 'down' : 'degraded';
      store.setHealth(ev.id, source.id, { ...h, status, failures, lastAttempt: nowIso(), lastError: `${nowIso()} ${e.message}` });
      log('error', 'ingest failed', { event: ev.id, source: source.id, failures, error: e.message });
      if (status === 'down' && h.status !== 'down') recompute(ev, store.contestIdsWithObservations(ev.id)); // fail over
      else refreshSummary(ev);
      return { ok: false, permanent: !!e.permanent, failures };
    }
  }

  function schedule(ev) {
    for (const [k, r] of runners) if (k.startsWith(`${ev.id}/`)) { clearTimeout(r.timer); runners.delete(k); }
    for (const k of [...adapters.keys()]) if (k.startsWith(`${ev.id}/`)) adapters.delete(k);
    if (ev.status === 'archived' || ev.status === 'completed') return;
    for (const source of ev.sources.filter(s => s.enabled)) {
      const key = `${ev.id}/${source.id}`;
      const runner = { timer: null, running: false };
      const loop = async () => {
        if (runner.running) return; runner.running = true;
        const r = await runOnce(ev, source);
        runner.running = false;
        if (r.permanent) return; // needs an editor to fix configuration
        const backoff = r.ok ? 1 : Math.min(10, 2 ** Math.min(r.failures, 4));
        const jitter = 1 + (Math.random() - 0.5) * 0.1;
        if (runners.get(key) === runner) runner.timer = setTimeout(loop, Math.max(15, source.intervalSec) * 1000 * backoff * jitter);
      };
      runners.set(key, runner);
      runner.timer = setTimeout(loop, 250);
    }
  }

  return {
    bus,
    start() { for (const ev of store.listEvents()) { schedule(ev); refreshSummary(ev); } },
    reschedule(ev) { schedule(ev); refreshSummary(ev); },
    stop() { for (const r of runners.values()) clearTimeout(r.timer); runners.clear(); },
    runOnce, recompute,
    summary(eventId) { const ev = store.getEvent(eventId); if (!ev) return null; if (!summaries.has(eventId)) refreshSummary(ev); return summaries.get(eventId); },
    contests: eventId => [...contestsOf(eventId).values()],
    contest: (eventId, id) => contestsOf(eventId).get(id) || null,
    adapterFor(eventId, sourceId) { const ev = store.getEvent(eventId); const s = ev?.sources.find(x => x.id === sourceId); if (!s) return null; const k = `${eventId}/${sourceId}`; if (!adapters.has(k)) adapters.set(k, createAdapter(s)); return adapters.get(k); },
    emitFeed: (eventId, item) => emitFeed(store.getEvent(eventId), item),
  };
}
