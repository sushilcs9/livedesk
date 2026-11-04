// Persistence. SQLite (built into Node 22) keeps the first deployment free and single-process.
// Every function here is the storage contract; a Postgres implementation can replace this file
// without touching ingestion, reconciliation or HTTP code.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowIso } from './util.js';

export function openStore(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, config TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS observations (
      event_id TEXT, source_id TEXT, contest_id TEXT, hash TEXT, payload TEXT, fetched_at TEXT,
      PRIMARY KEY (event_id, source_id, contest_id));
    CREATE TABLE IF NOT EXISTS contests (
      event_id TEXT, contest_id TEXT, payload TEXT, hash TEXT, updated_at TEXT,
      PRIMARY KEY (event_id, contest_id));
    CREATE TABLE IF NOT EXISTS feed (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, at TEXT, kind TEXT, contest_id TEXT,
      title TEXT, detail TEXT, source TEXT, source_url TEXT, reported_at TEXT);
    CREATE INDEX IF NOT EXISTS feed_event ON feed(event_id, id DESC);
    CREATE TABLE IF NOT EXISTS overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, contest_id TEXT, payload TEXT,
      actor TEXT, at TEXT, active INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, actor TEXT, role TEXT, action TEXT,
      target TEXT, before TEXT, after TEXT);
    CREATE TABLE IF NOT EXISTS source_health (
      event_id TEXT, source_id TEXT, payload TEXT, PRIMARY KEY (event_id, source_id));
  `);

  const q = sql => db.prepare(sql);
  const J = s => (s == null ? null : JSON.parse(s));

  return {
    db,
    upsertEvent(cfg) {
      q('INSERT INTO events (id, config, updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config, updated_at=excluded.updated_at')
        .run(cfg.id, JSON.stringify(cfg), nowIso());
    },
    getEvent: id => J(q('SELECT config FROM events WHERE id=?').get(id)?.config),
    listEvents: () => q('SELECT config FROM events ORDER BY id').all().map(r => J(r.config)),

    putObservation(eventId, sourceId, contestId, hash, payload) {
      const prev = q('SELECT hash FROM observations WHERE event_id=? AND source_id=? AND contest_id=?').get(eventId, sourceId, contestId);
      if (prev?.hash === hash) return false;
      q('INSERT INTO observations VALUES (?,?,?,?,?,?) ON CONFLICT(event_id, source_id, contest_id) DO UPDATE SET hash=excluded.hash, payload=excluded.payload, fetched_at=excluded.fetched_at')
        .run(eventId, sourceId, contestId, hash, JSON.stringify(payload), nowIso());
      return true;
    },
    observationsFor: (eventId, contestId) =>
      q('SELECT source_id, payload FROM observations WHERE event_id=? AND contest_id=?').all(eventId, contestId)
        .map(r => ({ sourceId: r.source_id, contest: J(r.payload) })),
    contestIdsWithObservations: eventId =>
      q('SELECT DISTINCT contest_id FROM observations WHERE event_id=?').all(eventId).map(r => r.contest_id),

    getContest: (eventId, contestId) => J(q('SELECT payload FROM contests WHERE event_id=? AND contest_id=?').get(eventId, contestId)?.payload),
    putContest(eventId, contest, hash) {
      q('INSERT INTO contests VALUES (?,?,?,?,?) ON CONFLICT(event_id, contest_id) DO UPDATE SET payload=excluded.payload, hash=excluded.hash, updated_at=excluded.updated_at')
        .run(eventId, contest.id, JSON.stringify(contest), hash, nowIso());
    },
    listContests: eventId => q('SELECT payload FROM contests WHERE event_id=?').all(eventId).map(r => J(r.payload)),

    addFeed(item) {
      const r = q('INSERT INTO feed (event_id, at, kind, contest_id, title, detail, source, source_url, reported_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(item.eventId, item.at || nowIso(), item.kind, item.contestId ?? null, item.title, JSON.stringify(item.detail ?? {}),
          item.source ?? null, item.sourceUrl ?? null, item.reportedAt ?? null);
      return { ...item, id: Number(r.lastInsertRowid) };
    },
    listFeed(eventId, { limit = 50, before = null, contestId = null } = {}) {
      let sql = 'SELECT * FROM feed WHERE event_id=?'; const args = [eventId];
      if (before) { sql += ' AND id < ?'; args.push(before); }
      if (contestId) { sql += ' AND contest_id = ?'; args.push(contestId); }
      sql += ' ORDER BY id DESC LIMIT ?'; args.push(Math.min(limit, 500));
      return q(sql).all(...args).map(r => ({
        id: r.id, eventId: r.event_id, at: r.at, kind: r.kind, contestId: r.contest_id, title: r.title,
        detail: J(r.detail), source: r.source, sourceUrl: r.source_url, reportedAt: r.reported_at }));
    },

    addOverride(eventId, contestId, payload, actor) {
      q('UPDATE overrides SET active=0 WHERE event_id=? AND contest_id=? AND active=1').run(eventId, contestId);
      q('INSERT INTO overrides (event_id, contest_id, payload, actor, at) VALUES (?,?,?,?,?)')
        .run(eventId, contestId, JSON.stringify(payload), actor, nowIso());
    },
    clearOverride: (eventId, contestId) => q('UPDATE overrides SET active=0 WHERE event_id=? AND contest_id=? AND active=1').run(eventId, contestId),
    activeOverride(eventId, contestId) {
      const r = q('SELECT payload, actor, at FROM overrides WHERE event_id=? AND contest_id=? AND active=1').get(eventId, contestId);
      return r ? { ...J(r.payload), actor: r.actor, at: r.at } : null;
    },

    audit(entry) {
      q('INSERT INTO audit (at, actor, role, action, target, before, after) VALUES (?,?,?,?,?,?,?)')
        .run(nowIso(), entry.actor, entry.role, entry.action, entry.target, JSON.stringify(entry.before ?? null), JSON.stringify(entry.after ?? null));
    },
    listAudit: (limit = 200) => q('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit)
      .map(r => ({ ...r, before: J(r.before), after: J(r.after) })),

    setHealth: (eventId, sourceId, h) => q('INSERT INTO source_health VALUES (?,?,?) ON CONFLICT(event_id, source_id) DO UPDATE SET payload=excluded.payload')
      .run(eventId, sourceId, JSON.stringify(h)),
    getHealth: (eventId, sourceId) => J(q('SELECT payload FROM source_health WHERE event_id=? AND source_id=?').get(eventId, sourceId)?.payload),
  };
}
