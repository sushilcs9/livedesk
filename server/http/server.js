import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { log, nowIso, hashOf } from '../core/util.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

function parseUsers(spec = '') {
  return spec.split(',').map(s => s.trim()).filter(Boolean).map(s => { const [name, role, token] = s.split(':'); return { name, role, digest: createHash('sha256').update(token || '').digest() }; })
    .filter(u => u.name && ROLE_RANK[u.role]);
}

export function createHttp({ store, engine, publicDir, adminUsers = process.env.ADMIN_USERS, rateLimitPerMin = 240 }) {
  const users = parseUsers(adminUsers);
  const buckets = new Map();
  const detailCache = new Map(); // contestId -> {at, data}
  let detailInFlight = 0;

  function rateLimited(req) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now(); const b = buckets.get(ip) || { tokens: rateLimitPerMin, at: now };
    b.tokens = Math.min(rateLimitPerMin, b.tokens + ((now - b.at) / 60000) * rateLimitPerMin); b.at = now;
    if (b.tokens < 1) { buckets.set(ip, b); return true; }
    b.tokens -= 1; buckets.set(ip, b);
    if (buckets.size > 50000) buckets.clear();
    return false;
  }

  function auth(req, minRole) {
    const h = req.headers.authorization || ''; const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!tok) return null;
    const d = createHash('sha256').update(tok).digest();
    const u = users.find(x => timingSafeEqual(x.digest, d));
    return u && ROLE_RANK[u.role] >= ROLE_RANK[minRole] ? u : null;
  }

  const send = (res, status, body, headers = {}) => {
    const json = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(json);
  };
  const cached = (req, res, data, maxAge = 10) => {
    const etag = `"${hashOf(data)}"`;
    const headers = { ETag: etag, 'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=30` };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    send(res, 200, data, headers);
  };
  const clean = c => { if (!c) return c; const { _hash, ...rest } = c; return rest; };
  async function body(req, limit = 5_000_000) {
    let size = 0; const chunks = [];
    for await (const ch of req) { size += ch.length; if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 }); chunks.push(ch); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }

  function publicEvent(ev) {
    const { sources, ...rest } = ev;
    return { ...rest, sources: sources.map(s => ({ id: s.id, name: s.name, homepage: s.homepage, license: s.license, trust: s.trust, enabled: s.enabled, priority: s.priority, intervalSec: s.intervalSec })) };
  }

  function filterContests(list, q) {
    const term = (q.get('q') || '').toLowerCase().trim();
    let out = list.filter(c =>
      (!q.get('office') || q.get('office').split(',').includes(c.office)) &&
      (!q.get('state') || c.jurisdiction.state === q.get('state').toUpperCase()) &&
      (!q.get('status') || q.get('status').split(',').includes(c.status) || (q.get('status').includes('called') && c.decided) || (q.get('status').includes('uncalled') && !c.decided)) &&
      (!q.get('party') || c.candidates.some(x => q.get('party').split(',').includes(x.party))) &&
      (!term || [c.officeLabel, c.jurisdiction.name, c.jurisdiction.state, c.jurisdiction.district && `${c.jurisdiction.state}-${c.jurisdiction.district}`, ...c.candidates.map(x => x.name)]
        .filter(Boolean).some(s => String(s).toLowerCase().includes(term))));
    const sort = q.get('sort') || 'default';
    const margin = c => c.margin ? Math.abs(c.margin.pts) : 999;
    const sorters = {
      margin: (a, b) => margin(a) - margin(b),
      competitive: (a, b) => (a.decided - b.decided) || margin(a) - margin(b),
      reporting: (a, b) => (b.reporting?.value ?? -1) - (a.reporting?.value ?? -1),
      updated: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
      default: (a, b) => a.office.localeCompare(b.office) || a.jurisdiction.state.localeCompare(b.jurisdiction.state) || (Number(a.jurisdiction.district) || 0) - (Number(b.jurisdiction.district) || 0)
    };
    out.sort(sorters[sort] || sorters.default);
    const limit = Math.min(Number(q.get('limit')) || 1000, 5000);
    return { total: out.length, contests: out.slice(0, limit).map(clean) };
  }

  async function serveStatic(req, res, path) {
    let p = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '') p = '/index.html';
    if (p === '/admin') p = '/admin.html';
    const file = join(publicDir, p);
    if (!file.startsWith(publicDir)) return send(res, 403, { error: 'Forbidden' });
    try {
      const st = await stat(file); if (!st.isFile()) throw new Error();
      const data = await readFile(file);
      const long = p.startsWith('/data/');
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': long ? 'public, max-age=86400' : 'public, max-age=60',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'" });
      res.end(data);
    } catch { const idx = await readFile(join(publicDir, 'index.html')); res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(idx); }
  }

  function sse(req, res, eventId) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 5000\n\n`);
    const write = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    let pendingSummary = null; let summaryTimer = null;
    const onSummary = s => { pendingSummary = s; summaryTimer ||= setTimeout(() => { write('summary', pendingSummary); summaryTimer = null; }, 1000); };
    const onContests = list => write('contests', list.map(c => ({ id: c.id, status: c.status, updatedAt: c.updatedAt })));
    const onFeed = item => write('feed', item);
    engine.bus.on(`summary:${eventId}`, onSummary); engine.bus.on(`contests:${eventId}`, onContests); engine.bus.on(`feed:${eventId}`, onFeed);
    const ping = setInterval(() => res.write(`: ping ${nowIso()}\n\n`), 25000);
    req.on('close', () => { clearInterval(ping); clearTimeout(summaryTimer); engine.bus.off(`summary:${eventId}`, onSummary); engine.bus.off(`contests:${eventId}`, onContests); engine.bus.off(`feed:${eventId}`, onFeed); });
  }

  async function adminRoute(req, res, parts, url) {
    const need = role => { const u = auth(req, role); if (!u) { send(res, users.length ? 401 : 503, { error: users.length ? 'Sign in with a token that has the required role.' : 'No administrators configured. Set ADMIN_USERS.' }); } return u; };
    const audit = (u, action, target, before, after) => store.audit({ actor: u.name, role: u.role, action, target, before, after });
    const [, , , evId, sub, subId, action] = parts; // /api/admin/events/:id/:sub/:subId/:action
    if (parts[2] === 'whoami') { const u = need('viewer'); if (u) send(res, 200, { name: u.name, role: u.role }); return; }
    if (parts[2] === 'audit') { const u = need('admin'); if (u) send(res, 200, store.listAudit()); return; }
    if (parts[2] !== 'events') return send(res, 404, { error: 'Not found' });

    if (!evId && req.method === 'POST') {
      const u = need('admin'); if (!u) return;
      const cfg = await body(req);
      if (!cfg.id || !/^[a-z0-9-]{3,64}$/.test(cfg.id) || !cfg.name || !cfg.module) return send(res, 400, { error: 'Event needs id (lowercase letters, digits, hyphens), name and module.' });
      if (store.getEvent(cfg.id)) return send(res, 409, { error: 'An event with that id already exists.' });
      const ev = { category: 'elections', status: 'upcoming', sources: [], rules: {}, dashboard: {}, languages: ['en'], timezone: 'UTC', ...cfg };
      store.upsertEvent(ev); audit(u, 'event.create', ev.id, null, ev); engine.reschedule(ev);
      return send(res, 201, ev);
    }
    const ev = store.getEvent(evId); if (!ev) return send(res, 404, { error: 'Unknown event' });

    if (!sub && req.method === 'PATCH') {
      const u = need('admin'); if (!u) return;
      const patch = await body(req); const allowed = ['name', 'shortName', 'status', 'startsAt', 'endsAt', 'dashboard', 'rules', 'languages', 'timezone', 'category', 'subcategory', 'country'];
      const next = { ...ev }; for (const k of allowed) if (k in patch) next[k] = patch[k];
      store.upsertEvent(next); audit(u, 'event.update', ev.id, ev, next); engine.reschedule(next);
      return send(res, 200, next);
    }
    if (sub === 'sources') {
      const u = need(action === 'run' ? 'editor' : 'admin'); if (!u) return;
      if (!subId && req.method === 'POST') {
        const s = await body(req);
        if (!s.id || !s.adapter || ev.sources.some(x => x.id === s.id)) return send(res, 400, { error: 'Source needs a new id and an adapter.' });
        const next = { ...ev, sources: [...ev.sources, { enabled: false, priority: 10, intervalSec: 60, params: {}, ...s }] };
        store.upsertEvent(next); audit(u, 'source.create', `${ev.id}/${s.id}`, null, s); engine.reschedule(next); return send(res, 201, next.sources.at(-1));
      }
      const src = ev.sources.find(s => s.id === subId); if (!src) return send(res, 404, { error: 'Unknown source' });
      if (action === 'run' && req.method === 'POST') { const r = await engine.runOnce(ev, src); audit(u, 'source.run', `${ev.id}/${src.id}`, null, r); return send(res, 200, r); }
      if (req.method === 'PATCH') {
        const patch = await body(req); const next = { ...src };
        for (const k of ['enabled', 'priority', 'intervalSec', 'params', 'name', 'license', 'trust', 'homepage']) if (k in patch) next[k] = patch[k];
        if (next.intervalSec < 15) return send(res, 400, { error: 'Refresh interval must be at least 15 seconds to respect providers.' });
        const nextEv = { ...ev, sources: ev.sources.map(s => s.id === src.id ? next : s) };
        store.upsertEvent(nextEv); audit(u, 'source.update', `${ev.id}/${src.id}`, src, next); engine.reschedule(nextEv);
        return send(res, 200, next);
      }
    }
    if (sub === 'contests' && subId && action === 'override') {
      const u = need('editor'); if (!u) return;
      const cid = decodeURIComponent(subId); const before = store.activeOverride(ev.id, cid);
      if (req.method === 'DELETE') { store.clearOverride(ev.id, cid); audit(u, 'override.clear', `${ev.id}/${cid}`, before, null); }
      else {
        const o = await body(req);
        if (o.call && !['projected', 'certified', 'retracted', 'none'].includes(o.call.status)) return send(res, 400, { error: 'call.status must be projected, certified, retracted or none.' });
        if (o.call && ['projected', 'certified'].includes(o.call.status) && !(o.call.by && o.call.sourceUrl)) return send(res, 400, { error: 'A manual call must name who made it (call.by) and link to it (call.sourceUrl).' });
        store.addOverride(ev.id, cid, o, u.name); audit(u, 'override.set', `${ev.id}/${cid}`, before, o);
      }
      const changed = engine.recompute(ev, [cid]);
      return send(res, 200, { ok: true, contest: clean(engine.contest(ev.id, cid)), changed: changed.length });
    }
    if (sub === 'announcements' && req.method === 'POST') {
      const u = need('editor'); if (!u) return;
      const a = await body(req); if (!a.title || !a.source) return send(res, 400, { error: 'Announcement needs a title and a source.' });
      engine.emitFeed(ev.id, { kind: a.kind || 'announcement', title: a.title, source: a.source, sourceUrl: a.sourceUrl ?? null, reportedAt: a.reportedAt ?? nowIso(), contestId: a.contestId ?? null, detail: { by: u.name } });
      audit(u, 'feed.announce', ev.id, null, a); return send(res, 201, { ok: true });
    }
    if (sub === 'upload' && req.method === 'POST') {
      const u = need('editor'); if (!u) return;
      const payload = await body(req); const sourceId = payload.sourceId || 'manual';
      let evNext = ev;
      if (!ev.sources.some(s => s.id === sourceId)) { evNext = { ...ev, sources: [...ev.sources, { id: sourceId, adapter: 'jsonfeed', name: payload.sourceName || 'Editor upload', trust: 'editorial', enabled: true, priority: payload.priority ?? 60, intervalSec: 86400, params: { url: '' }, license: payload.license || 'Entered by editors' }] }; store.upsertEvent(evNext); }
      const ids = [];
      for (const c of payload.contests || []) {
        if (!c.id || !c.office || !c.jurisdiction?.state || !Array.isArray(c.candidates)) return send(res, 400, { error: `Contest ${c.id ?? '(no id)'} is missing id, office, jurisdiction.state or candidates.` });
        const obs = { kind: 'candidate', level: 'state', flags: [], call: { status: 'none', winnerIds: [] }, reporting: { value: null, label: 'Not reported', definition: 'Entered by an editor.' }, ...c,
          provenance: { sourceId, sourceName: payload.sourceName || 'Editor upload', url: payload.sourceUrl ?? null, humanUrl: payload.sourceUrl ?? null, fetchedAt: nowIso(), sourceUpdatedAt: payload.reportedAt ?? null } };
        store.putObservation(ev.id, sourceId, c.id, hashOf(obs), obs); ids.push(c.id);
      }
      audit(u, 'data.upload', `${ev.id}/${sourceId}`, null, { count: ids.length, sourceUrl: payload.sourceUrl });
      const changed = engine.recompute(evNext, ids); return send(res, 200, { ok: true, received: ids.length, published: changed.length });
    }
    send(res, 404, { error: 'Not found' });
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts[0] !== 'api') return serveStatic(req, res, url.pathname);
      if (parts[1] !== 'admin' && rateLimited(req)) return send(res, 429, { error: 'Too many requests. Please slow down.' }, { 'Retry-After': '10' });
      if (parts[1] === 'admin') return await adminRoute(req, res, parts, url);
      if (parts[1] === 'health') return send(res, 200, { ok: true, at: nowIso() });
      if (parts[1] === 'search') {
        const term = (url.searchParams.get('q') || '').toLowerCase().trim(); if (term.length < 2) return send(res, 200, { events: [], contests: [] });
        const events = store.listEvents().filter(e => `${e.name} ${e.country} ${e.category}`.toLowerCase().includes(term)).map(publicEvent);
        const contests = store.listEvents().flatMap(e => filterContests(engine.contests(e.id), new URLSearchParams({ q: term, limit: '30', sort: 'competitive' })).contests.map(c => ({ eventId: e.id, ...c })));
        return cached(req, res, { events, contests: contests.slice(0, 40) }, 15);
      }
      if (parts[1] !== 'events') return send(res, 404, { error: 'Not found' });
      if (!parts[2]) return cached(req, res, store.listEvents().map(e => { const s = engine.summary(e.id)?.data; return { ...publicEvent(e), counts: s?.counts ?? null, generatedAt: s?.generatedAt ?? null }; }), 30);
      const ev = store.getEvent(parts[2]); if (!ev) return send(res, 404, { error: 'Unknown event' });
      const sub = parts[3];
      if (!sub) return cached(req, res, publicEvent(ev), 30);
      if (sub === 'summary') {
        const s = engine.summary(ev.id);
        if (req.headers['if-none-match'] === s.etag) { res.writeHead(304, { ETag: s.etag }); return res.end(); }
        return send(res, 200, s.data, { ETag: s.etag, 'Cache-Control': 'public, max-age=5, s-maxage=5, stale-while-revalidate=30' });
      }
      if (sub === 'stream') return sse(req, res, ev.id);
      if (sub === 'feed') return cached(req, res, store.listFeed(ev.id, { limit: Number(url.searchParams.get('limit')) || 50, before: Number(url.searchParams.get('before')) || null, contestId: url.searchParams.get('contest') }), 5);
      if (sub === 'contests' && !parts[4]) return cached(req, res, filterContests(engine.contests(ev.id), url.searchParams), 10);
      if (sub === 'contests' && parts[4]) {
        const cid = decodeURIComponent(parts[4]); const c = engine.contest(ev.id, cid);
        if (!c) return send(res, 404, { error: 'Unknown contest' });
        if (parts[5] === 'detail') {
          const hit = detailCache.get(cid);
          if (hit && Date.now() - hit.at < 60000) return cached(req, res, hit.data, 30);
          const primary = c.sources?.find(s => s.primary); const adapter = primary && engine.adapterFor(ev.id, primary.id);
          if (!adapter?.detail) return cached(req, res, { regions: null, note: 'This source does not provide sub-geography results.' }, 60);
          if (detailInFlight >= 3) return send(res, 503, { error: 'Detail service busy. Try again shortly.' }, { 'Retry-After': '5' });
          detailInFlight++;
          try { const d = await adapter.detail(c); const data = { ...(d || { regions: null }), source: primary.name, fetchedAt: nowIso() }; detailCache.set(cid, { at: Date.now(), data }); return cached(req, res, data, 30); }
          catch (e) { return send(res, 502, { error: `Could not load sub-geography results from ${primary.name}: ${e.message}` }); }
          finally { detailInFlight--; }
        }
        return cached(req, res, { contest: clean(c), feed: store.listFeed(ev.id, { contestId: cid, limit: 30 }) }, 5);
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      log('error', 'request failed', { path: url.pathname, error: e.message });
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    }
  });
}
