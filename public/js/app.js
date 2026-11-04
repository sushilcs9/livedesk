import { STRINGS } from './i18n.js';

// ---------- small utilities ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('ld:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ld:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
};
const S = {
  lang: store.get('lang', (navigator.language || 'en').startsWith('es') ? 'es' : 'en'),
  tz: store.get('tz', 'local'),
  follows: new Set(store.get('follows', [])),
  event: null, summary: null, feed: [], contests: null, mapData: null, mapLayer: store.get('mapLayer', 'us_senate'), mapMode: 'map',
  es: null, live: 'idle', pollTimer: null
};
const t = k => STRINGS[S.lang]?.[k] ?? STRINGS.en[k] ?? k;
const PARTY = { DEM: 'Democrat', REP: 'Republican', IND: 'Independent', LIB: 'Libertarian', GRN: 'Green', OTH: 'Other', YES: 'Yes', NO: 'No' };
const pVar = p => ({ DEM: 'var(--dem)', REP: 'var(--rep)', IND: 'var(--ind)' }[p] || 'var(--oth)');
const pSoft = p => ({ DEM: 'var(--dem-soft)', REP: 'var(--rep-soft)', IND: 'var(--ind-soft)' }[p] || 'var(--oth-soft)');
const fmtN = n => n == null ? '—' : Number(n).toLocaleString(S.lang === 'es' ? 'es-US' : 'en-US');
const fmtPct = n => n == null ? '—' : `${Number(n).toFixed(1)}%`;
const TZ = { local: null, 'America/New_York': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT', 'America/Los_Angeles': 'PT', 'America/Anchorage': 'AKT', 'Pacific/Honolulu': 'HT', UTC: 'UTC' };
function fmtTime(iso, withDate = false) {
  if (!iso) return '—';
  const d = new Date(iso); if (Number.isNaN(+d)) return '—';
  const opts = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(withDate ? { month: 'short', day: 'numeric' } : {}) };
  if (S.tz !== 'local') opts.timeZone = S.tz;
  return new Intl.DateTimeFormat(S.lang === 'es' ? 'es-US' : 'en-US', opts).format(d);
}
function ago(iso) {
  if (!iso) return ''; const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return S.lang === 'es' ? 'hace instantes' : 'just now';
  if (s < 3600) return S.lang === 'es' ? `hace ${Math.round(s / 60)} min` : `${Math.round(s / 60)} min ago`;
  return fmtTime(iso, s > 20 * 3600);
}
const etags = new Map();
async function api(path) {
  const prev = etags.get(path);
  const res = await fetch(path, { headers: prev ? { 'If-None-Match': prev.etag } : {} });
  if (res.status === 304 && prev) return prev.data;
  if (!res.ok) { let msg = `The server answered ${res.status}.`; try { msg = (await res.json()).error || msg; } catch {} throw new Error(msg); }
  const data = await res.json();
  if (res.headers.get('etag')) etags.set(path, { etag: res.headers.get('etag'), data });
  return data;
}
function toast(html, ms = 7000) {
  const el = document.createElement('div'); el.className = 'toast'; el.innerHTML = html; $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}
const raceLabel = c => {
  const where = c.jurisdiction.district ? `${c.jurisdiction.state}-${c.jurisdiction.district}` : c.jurisdiction.name;
  return `${where} ${c.officeLabel}`;
};
const raceHref = c => `#/e/${encodeURIComponent(S.event?.id || c.eventId)}/race/${encodeURIComponent(c.id)}`;
const statusPill = c => {
  const st = c.call?.status === 'retracted' && !c.decided ? 'retracted' : c.status;
  return `<span class="pill ${st}">${esc(t('status.' + st))}</span>`;
};

// ---------- chrome ----------
function applyTheme(th) { if (th) document.documentElement.dataset.theme = th; else delete document.documentElement.dataset.theme; }
applyTheme(store.get('theme', null));
$('#themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark'; store.set('theme', next); applyTheme(next);
};
$('#langSelect').value = S.lang;
$('#langSelect').onchange = e => { S.lang = e.target.value; store.set('lang', S.lang); document.documentElement.lang = S.lang; translateChrome(); route(); };
$('#tzSelect').innerHTML = Object.entries(TZ).map(([k, v]) => `<option value="${k}">${v || (S.lang === 'es' ? 'Hora local' : 'Local time')}</option>`).join('');
$('#tzSelect').value = S.tz;
$('#tzSelect').onchange = e => { S.tz = e.target.value; store.set('tz', S.tz); route(); };
function translateChrome() {
  $$('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
}
translateChrome();
document.documentElement.lang = S.lang;
$('#searchForm').onsubmit = e => {
  e.preventDefault(); const q = $('#searchInput').value.trim(); if (!q) return;
  location.hash = S.event ? `#/e/${S.event.id}/races?q=${encodeURIComponent(q)}` : `#/search?q=${encodeURIComponent(q)}`;
};
function setCrumbs(items) {
  $('#crumbs').innerHTML = items.map((it, i) => (i ? '<span aria-hidden="true">/</span>' : '') + (it.href ? `<a href="${it.href}">${esc(it.label)}</a>` : `<span aria-current="page">${esc(it.label)}</span>`)).join('');
}
function setLive(state) {
  S.live = state; const el = $('#liveState');
  el.className = 'live ' + (state === 'on' ? 'on' : state === 'off' ? 'off' : '');
  el.textContent = state === 'on' ? t('live.on') : state === 'off' ? t('live.off') : state === 'poll' ? t('live.poll') : '';
}
function setBanner() {
  const b = $('#banner');
  if (S.summary?.sample) { b.innerHTML = `<div class="banner sample"><div class="wrap"><strong>SAMPLE DATA</strong><span>${esc(t('sample.banner'))}</span></div></div>`; return; }
  const down = (S.summary?.sourcesStatus || []).filter(s => s.enabled && ['down', 'misconfigured'].includes(s.health?.status));
  b.innerHTML = down.length ? `<div class="banner warn"><div class="wrap"><strong>Source problem.</strong><span>${down.map(s => esc(s.name)).join(', ')} ${down.length > 1 ? 'are' : 'is'} not responding. Figures shown are the last ones received; check the update times.</span></div></div>` : '';
}
function setFootSources() {
  const srcs = (S.summary?.sourcesStatus || []).filter(s => s.enabled);
  $('#footSources').innerHTML = srcs.length ? srcs.map(s => s.homepage ? `<a href="${esc(s.homepage)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)).join(', ') : '—';
}

// ---------- live connection ----------
function connect(eventId) {
  if (S.es?.eventId === eventId) return;
  S.es?.close(); clearInterval(S.pollTimer);
  const es = new EventSource(`/api/events/${encodeURIComponent(eventId)}/stream`); es.eventId = eventId; S.es = es;
  es.onopen = () => { setLive('on'); clearInterval(S.pollTimer); };
  es.onerror = () => {
    setLive('off');
    clearInterval(S.pollTimer);
    S.pollTimer = setInterval(async () => { try { S.summary = await api(`/api/events/${eventId}/summary`); onSummary(); setLive('poll'); } catch {} }, 30000);
  };
  es.addEventListener('summary', e => { S.summary = JSON.parse(e.data); onSummary(); });
  es.addEventListener('feed', e => { const item = JSON.parse(e.data); S.feed.unshift(item); S.feed = S.feed.slice(0, 200); onFeed(item); });
  es.addEventListener('contests', e => { onContests(JSON.parse(e.data)); });
}
let refreshTimer = null;
function onSummary() { setBanner(); setFootSources(); if (view.onSummary) view.onSummary(); }
function onFeed(item) {
  if (view.onFeed) view.onFeed(item);
  const followed = item.contestId && (S.follows.has(item.contestId) || S.follows.has('state:' + item.contestId.split(':')[1]?.slice(0, 2)));
  const important = ['call', 'certified', 'retraction', 'conflict', 'control'].includes(item.kind);
  if (followed || item.kind === 'control') {
    const link = item.contestId ? ` <a href="#/e/${S.event.id}/race/${encodeURIComponent(item.contestId)}">Open</a>` : '';
    toast(`${esc(item.title)}${link}`);
    if (followed && important && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
      try { new Notification('LiveDesk', { body: `${item.title} (source: ${item.source || 'unknown'})`, tag: `ld-${item.id}` }); } catch {}
    }
  }
}
function onContests(list) {
  if (!view.onContests) return;
  clearTimeout(refreshTimer); refreshTimer = setTimeout(() => view.onContests(list), 1500);
}

// ---------- shared renderers ----------
function chamberCard(key, ch) {
  const order = ['DEM', 'IND', 'OTH', 'LIB', 'GRN', 'REP'];
  const seats = ch.seats || {}, lead = ch.leading || {};
  const total = ch.total || Object.values(seats).reduce((a, b) => a + b, 0) + ch.undecided;
  const leadTotal = Object.values(lead).reduce((a, b) => a + b, 0);
  const noLeader = Math.max(0, total - Object.values(seats).reduce((a, b) => a + b, 0) - leadTotal);
  const seg = (cls, n, title) => n > 0 ? `<span class="${cls}" style="width:${(n / total) * 100}%" title="${esc(title)}"></span>` : '';
  const left = ['DEM', 'IND'], right = ['REP'];
  const bar = [
    ...order.filter(p => !right.includes(p)).map(p => seg(`seg-${p.toLowerCase()}`, seats[p] || 0, `${PARTY[p] || p}: ${seats[p] || 0} seats`)),
    ...order.filter(p => !right.includes(p)).map(p => seg(`seg-${p.toLowerCase()} lead`, lead[p] || 0, `${PARTY[p] || p} leading: ${lead[p] || 0}`)),
    seg('', noLeader, `${noLeader} with no leader yet`),
    ...right.map(p => seg(`seg-${p.toLowerCase()} lead`, lead[p] || 0, `${PARTY[p]} leading: ${lead[p] || 0}`)),
    ...right.map(p => seg(`seg-${p.toLowerCase()}`, seats[p] || 0, `${PARTY[p]}: ${seats[p] || 0} seats`))
  ].join('');
  const others = Object.entries(seats).filter(([p, n]) => !['DEM', 'REP'].includes(p) && n > 0);
  const control = ch.control
    ? `<span class="control">${esc(PARTY[ch.control.party] || ch.control.party)}s have ${ch.control.seats} seats, a majority, on called races</span>`
    : ch.majority ? `<span class="control muted">Control not yet determined</span>` : `<span class="muted small">Governorships: no chamber majority applies</span>`;
  const net = ch.netChange ? Object.entries(ch.netChange).filter(([, v]) => v).map(([p, v]) => `${p.charAt(0)} ${v > 0 ? '+' : ''}${v}`).join(' · ') || 'No seats changed party yet' : null;
  return `<section class="panel chamber" aria-labelledby="ch-${key}">
    <div class="chamber-top"><h2 id="ch-${key}">${esc(ch.label)}</h2><span class="small muted num">${ch.called}/${ch.racesUp} ${t('called')}</span></div>
    <div class="tally">
      <div class="side dem"><span class="big">${seats.DEM || 0}</span><span class="small">Democrats</span></div>
      <div class="mid">${ch.majority ? `<b class="num">${ch.majority}</b><br>${t('majority')}` : ''}</div>
      <div class="side r rep"><span class="big">${seats.REP || 0}</span><span class="small">Republicans</span></div>
    </div>
    <div class="seatbar" role="img" aria-label="${esc(`${ch.label}: Democrats ${seats.DEM || 0} seats, Republicans ${seats.REP || 0} seats${others.length ? ', ' + others.map(([p, n]) => `${PARTY[p] || p} ${n}`).join(', ') : ''}. Leading in uncalled races: Democrats ${lead.DEM || 0}, Republicans ${lead.REP || 0}. ${noLeader} seats with no leader yet.`)}">
      ${bar}${ch.majority ? `<span class="marker" style="left:calc(${(ch.majority / total) * 100}% - 1px)" aria-hidden="true"></span>` : ''}
    </div>
    <div class="chamber-foot">${control}<span class="num">${others.map(([p, n]) => `${esc(PARTY[p] || p)} ${n}`).join(' · ')}</span></div>
    <div class="chamber-foot muted"><span>${ch.holdover && Object.values(ch.holdover).some(Boolean) ? `Includes seats not up: D ${ch.holdover.DEM || 0}, R ${ch.holdover.REP || 0}` : 'All seats up this year'}</span>${net ? `<span title="${esc(ch.netChangeNote)}">Net change: ${esc(net)}</span>` : `<span title="${esc(ch.netChangeNote)}">Net change: not computed</span>`}</div>
  </section>`;
}
function chambersLegend() {
  return `<div class="legend"><span><i class="seg-dem"></i><i class="seg-rep" style="margin-left:-3px"></i>${t('seats.held')}</span><span><i class="seg-dem lead"></i><i class="seg-rep lead" style="margin-left:-3px"></i>${t('seats.leading')}</span><span><i style="background:var(--none)"></i>${t('seats.undecided')}</span><span><i style="background:var(--ink);width:3px"></i>Majority line</span></div>`;
}
function feedList(items, { compact = false } = {}) {
  if (!items.length) return `<div class="empty">No updates yet. New results, race calls and lead changes appear here as sources report them.</div>`;
  return `<ul class="feed">${items.map(it => `<li class="k-${esc(it.kind)}"><span class="bar" aria-hidden="true"></span><div>
    <div class="t">${it.contestId && S.event ? `<a href="#/e/${S.event.id}/race/${encodeURIComponent(it.contestId)}">${esc(it.title)}</a>` : esc(it.title)}</div>
    <div class="m"><span>${esc(fmtTime(it.at))}</span>${it.source ? `<span>Source: ${it.sourceUrl && /^https?:/.test(it.sourceUrl) ? `<a href="${esc(it.sourceUrl)}" target="_blank" rel="noopener">${esc(it.source)}</a>` : esc(it.source)}</span>` : ''}${!compact && it.reportedAt && it.reportedAt !== it.at ? `<span>Reported ${esc(fmtTime(it.reportedAt))}</span>` : ''}</div></div></li>`).join('')}</ul>`;
}
function miniBar(c) {
  const tot = c.totalVotes || 0; if (!tot) return '<div class="mini" aria-hidden="true"></div>';
  return `<div class="mini" aria-hidden="true">${c.candidates.slice(0, 4).map(x => `<span style="width:${(x.votes / tot) * 100}%;background:${pVar(x.party)}"></span>`).join('')}</div>`;
}
function leaderCell(c) {
  if (c.heldCounts) return `<span class="muted">Counts held</span>`;
  const w = c.candidates.find(x => x.winner);
  const who = w || (c.leader && c.candidates[0]);
  if (!who) return `<span class="muted">${c.uncontested ? esc(c.candidates[0]?.name) : '—'}</span>`;
  return `<span class="party-dot p-${esc(who.party)}" aria-hidden="true"></span>${w ? '<span class="chk" aria-label="Projected winner">✓ </span>' : ''}${esc(who.name)} <span class="muted small">(${esc(who.party === 'OTH' ? who.partyLabel : who.party.charAt(0))})</span>`;
}
function racesTable(list, { showFollow = true } = {}) {
  if (!list.length) return `<div class="empty">No races match these filters.</div>`;
  return `<div class="table-scroll"><table class="races"><thead><tr><th scope="col">Race</th><th scope="col">Status</th><th scope="col">Winner or leader</th><th scope="col" class="n">Margin</th><th scope="col" class="hide-sm">Votes</th><th scope="col" class="n">Reporting</th><th scope="col" class="n hide-sm">Updated</th>${showFollow ? '<th scope="col"><span class="sr-only">Follow</span></th>' : ''}</tr></thead><tbody>
  ${list.map(c => `<tr>
    <td><a class="rl" href="${raceHref(c)}">${esc(raceLabel(c))}</a>${c.flags?.includes('sample-data') ? ' <span class="pill sample">Sample</span>' : ''}</td>
    <td>${statusPill(c)}</td>
    <td>${leaderCell(c)}</td>
    <td class="n">${c.margin && !c.heldCounts ? `${c.margin.pts.toFixed(1)} pts` : '—'}</td>
    <td class="hide-sm">${miniBar(c)}</td>
    <td class="n" title="${esc(c.reporting?.definition || '')}">${c.reporting?.value != null ? fmtPct(c.reporting.value) : '—'}</td>
    <td class="n hide-sm">${esc(fmtTime(c.updatedAt))}</td>
    ${showFollow ? `<td><button class="btn follow" data-id="${esc(c.id)}" aria-pressed="${S.follows.has(c.id)}" aria-label="${S.follows.has(c.id) ? 'Unfollow' : 'Follow'} ${esc(raceLabel(c))}">${S.follows.has(c.id) ? '★' : '☆'}</button></td>` : ''}
  </tr>`).join('')}</tbody></table></div>`;
}
function bindFollow(root) {
  $$('.follow', root).forEach(b => b.onclick = () => toggleFollow(b.dataset.id, b));
}
function toggleFollow(id, btn) {
  if (S.follows.has(id)) S.follows.delete(id); else S.follows.add(id);
  store.set('follows', [...S.follows]);
  if (btn) { const on = S.follows.has(id); btn.setAttribute('aria-pressed', on); if (btn.textContent.length <= 2) btn.textContent = on ? '★' : '☆'; else btn.textContent = on ? `★ ${t('following')}` : `☆ ${t('follow')}`; }
  if (S.follows.has(id) && 'Notification' in window && Notification.permission === 'default')
    toast(`Following. You will see alerts on this page when a source calls or updates it. <a href="#" id="notifAsk">Also allow browser notifications</a>`, 9000), setTimeout(() => { const a = $('#notifAsk'); if (a) a.onclick = e => { e.preventDefault(); Notification.requestPermission(); }; }, 0);
}
async function loadContests(force = false) {
  if (!S.contests || force) S.contests = (await api(`/api/events/${S.event.id}/contests?limit=5000`)).contests;
  return S.contests;
}

// ---------- map ----------
async function mapData() { if (!S.mapData) S.mapData = await api('/data/us-states.json'); return S.mapData; }
function stateCell(abbr, layer) {
  const st = S.summary?.states?.[abbr]; const name = S.mapData?.states.find(s => s.abbr === abbr)?.name || abbr;
  if (layer === 'us_house') {
    const h = st?.offices?.us_house;
    if (!h) return { fill: 'var(--none)', label: `${name}: no House results yet`, dark: false };
    const won = Object.entries(h.won).sort((a, b) => b[1] - a[1]); const calledN = won.reduce((a, [, n]) => a + n, 0);
    const tip = `${name}: ${h.seats} House seat${h.seats > 1 ? 's' : ''}. Called: ${won.map(([p, n]) => `${p.charAt(0)} ${n}`).join(', ') || 'none'}. Leading: ${Object.entries(h.leading).map(([p, n]) => `${p.charAt(0)} ${n}`).join(', ') || 'none'}.`;
    if (!calledN) return { fill: 'var(--none)', label: tip, dark: false };
    const top = won[0][0]; const allCalled = calledN === h.seats;
    return { fill: allCalled ? pVar(top) : `url(#lead-${['DEM', 'REP'].includes(top) ? top : 'OTH'})`, label: tip + (allCalled ? '' : ' Shading shows the party with the most called seats so far.'), dark: allCalled };
  }
  const cell = st?.offices?.[layer];
  if (!cell) return { fill: 'var(--none)', label: `${name}: no ${layer === 'governor' ? 'governor' : 'Senate'} race this year`, dark: false, none: true };
  if (cell.status === 'held') return { fill: 'var(--none)', label: `${name}: counts held after a data check`, dark: false };
  if (cell.decided) return { fill: pVar(cell.party), label: `${name}: ${cell.winner} (${cell.party}) projected winner${cell.reporting ? '. ' + cell.reporting : ''}`, dark: true };
  if (cell.party && cell.leader) return { fill: `url(#lead-${['DEM', 'REP'].includes(cell.party) ? cell.party : 'OTH'})`, label: `${name}: ${cell.leader} (${cell.party}) leads by ${cell.marginPts?.toFixed(1)} pts. Not called. ${cell.reporting || ''}`, dark: false };
  return { fill: 'var(--none)', label: `${name}: ${cell.status === 'counting' ? 'counting, no leader' : 'no results yet'}`, dark: false };
}
function mapSvg(layer) {
  const md = S.mapData;
  const defs = ['DEM', 'REP', 'OTH'].map(p => `<pattern id="lead-${p}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="6" height="6" fill="${pSoft(p)}"/><rect width="2.2" height="6" fill="${pVar(p)}"/></pattern>`).join('');
  const paths = md.states.map(s => { const c = stateCell(s.abbr, layer); return `<path d="${s.d}" fill="${c.fill}" ${c.none ? 'fill-opacity=".55"' : ''} tabindex="0" role="link" data-abbr="${s.abbr}" aria-label="${esc(c.label)}" data-tip="${esc(c.label)}"></path>`; }).join('');
  const labels = md.states.filter(s => s.area > 1800).map(s => { const c = stateCell(s.abbr, layer); return `<text x="${s.cx}" y="${s.cy}" text-anchor="middle" dominant-baseline="middle" class="${c.dark ? 'on-dark' : ''}">${s.abbr}</text>`; }).join('');
  return `<svg viewBox="0 0 ${md.width} ${md.height}" role="group" aria-label="Map of states. Select a state to see its races."><defs>${defs}</defs>${paths}${labels}</svg>`;
}
function stateTiles(layer) {
  return `<div class="state-tiles">${S.mapData.states.map(s => { const c = stateCell(s.abbr, layer); const solid = c.dark;
    return `<a href="#/e/${S.event.id}/state/${s.abbr}" style="${solid ? `background:${c.fill};color:#fff;border-color:transparent` : c.fill.startsWith('url') ? `border:2px solid ${pVar(c.fill.includes('DEM') ? 'DEM' : c.fill.includes('REP') ? 'REP' : 'OTH')}` : ''}" aria-label="${esc(c.label)}">${s.abbr}<small>${solid ? 'Called' : c.fill.startsWith('url') ? 'Leading' : ''}</small></a>`; }).join('')}</div>`;
}
function bindMap(root) {
  const tip = $('#tooltip');
  $$('path[data-abbr]', root).forEach(p => {
    const go = () => { location.hash = `#/e/${S.event.id}/state/${p.dataset.abbr}`; };
    p.onclick = go; p.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    const show = e => { tip.innerHTML = `<b>${esc(p.dataset.abbr)}</b>${esc(p.dataset.tip)}`; tip.hidden = false; const r = e.clientX ? { x: e.clientX, y: e.clientY } : (() => { const b = p.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top }; })(); tip.style.left = Math.min(innerWidth - 270, r.x + 12) + 'px'; tip.style.top = (r.y + 14) + 'px'; };
    p.onmousemove = show; p.onfocus = show; p.onmouseleave = p.onblur = () => { tip.hidden = true; };
  });
}
function mapLegend(layer) {
  return `<div class="legend"><span><i style="background:var(--dem)"></i>Dem. won</span><span><i style="background:var(--rep)"></i>Rep. won</span><span><i style="background:var(--ind)"></i>Ind./other won</span><span><i class="seg-dem lead"></i><i class="seg-rep lead" style="margin-left:-3px"></i>${layer === 'us_house' ? 'Some seats called' : 'Leading, not called'}</span><span><i style="background:var(--none)"></i>${layer === 'us_house' ? 'None called yet' : 'No results or no race'}</span></div>`;
}

// ---------- views ----------
let view = {};
const VIEWS = {
  async home() {
    S.event = null; S.es?.close(); S.es = null; setLive('idle'); $('#banner').innerHTML = '';
    setCrumbs([{ label: t('home.title') }]);
    const main = $('#main');
    main.innerHTML = `<div class="wrap"><div class="page-head"><div><p class="eyebrow">LiveDesk</p><h1>${t('home.title')}</h1><p class="muted">${t('home.sub')}</p></div>
      <div class="row"><div class="seg-ctl" role="group" aria-label="Filter by status" id="evFilter">${['all', 'live', 'upcoming', 'completed'].map((k, i) => `<button type="button" data-k="${k}" aria-pressed="${i === 0}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
      <select id="evCat" aria-label="Category" class="btn"><option value="">All categories</option><option value="elections">Elections</option><option value="economics">Economic releases</option><option value="sports">Sports</option></select></div></div>
      <div class="grid events" id="evList"><div class="panel event-card"><div class="skeleton"></div><div class="skeleton" style="width:60%"></div></div></div></div>`;
    let events;
    try { events = await api('/api/events'); } catch (e) { $('#evList').innerHTML = `<div class="empty">Could not load events. ${esc(e.message)}</div>`; return; }
    let f = 'all', cat = '';
    const draw = () => {
      const list = events.filter(e => (f === 'all' || e.status === f) && (!cat || e.category === cat));
      $('#evList').innerHTML = list.length ? list.map(e => `<a class="panel event-card" href="#/e/${esc(e.id)}">
        <span class="eyebrow ${e.status === 'live' ? 'status-live' : ''}">${esc(e.status)} · ${esc(e.category)} · ${esc(e.country)}</span>
        <h2>${esc(e.name)}</h2>
        ${e.counts ? `<p class="small num">${e.counts.total} races · ${e.counts.called} called · ${e.counts.counting} counting</p>` : ''}
        <p class="small muted">${e.generatedAt ? `${t('updated')} ${esc(ago(e.generatedAt))}` : ''} · ${esc(e.sources.filter(s => s.enabled).map(s => s.name).join(', '))}</p></a>`).join('')
        : `<div class="empty">No events match. Economic and sports modules are planned; administrators can add events from the admin panel.</div>`;
    };
    draw();
    $$('#evFilter button').forEach(b => b.onclick = () => { f = b.dataset.k; $$('#evFilter button').forEach(x => x.setAttribute('aria-pressed', x === b)); draw(); });
    $('#evCat').onchange = e => { cat = e.target.value; draw(); };
  },

  async event(id) {
    await enterEvent(id);
    setCrumbs([{ label: t('home.title'), href: '#/' }, { label: S.event.shortName || S.event.name }]);
    const main = $('#main');
    main.innerHTML = `<div class="wrap">
      <div class="page-head"><div><p class="eyebrow">${esc(S.event.category)} · ${esc(S.event.country)}</p><h1>${esc(S.event.name)}</h1></div>
        <div class="meta" id="evMeta"></div></div>
      <div class="grid chambers" id="chambers"></div>
      <div style="margin:-6px 0 18px">${chambersLegend()}</div>
      <div class="grid main-grid">
        <div class="stack">
          <section class="panel" aria-labelledby="mapH"><div class="panel-head"><h2 id="mapH">${t('map.title')}</h2>
            <div class="row"><div class="map-tabs" role="group" aria-label="Map layer">${[['us_senate', 'Senate'], ['governor', 'Governor'], ['us_house', 'House']].map(([k, l]) => `<button type="button" data-layer="${k}" aria-pressed="${S.mapLayer === k}">${l}</button>`).join('')}</div>
            <div class="seg-ctl" role="group" aria-label="Map or list">${[['map', t('map.map')], ['list', t('map.list')]].map(([k, l]) => `<button type="button" data-mode="${k}" aria-pressed="${S.mapMode === k}">${l}</button>`).join('')}</div></div></div>
            <div class="panel-body"><div class="map-wrap" id="mapBox"><div class="skeleton" style="height:300px"></div></div><div id="mapLegend" style="margin-top:10px"></div></div></section>
          <section class="panel" aria-labelledby="closeH"><div class="panel-head"><h2 id="closeH">${t('close.title')}</h2><span class="small muted" id="closeDef"></span></div><div id="closeBox"></div></section>
        </div>
        <section class="panel" aria-labelledby="feedH"><div class="panel-head"><h2 id="feedH">${t('feed.title')}</h2><span class="small muted">Newest first</span></div><div class="panel-body feed-scroll" id="feedBox"></div></section>
      </div>
      <section class="panel" style="margin-top:16px" aria-labelledby="racesH"><div class="panel-head"><h2 id="racesH">Key races</h2><a class="btn" href="#/e/${S.event.id}/races">${t('races.title')} →</a></div><div id="keyRaces"></div></section>
    </div>`;
    $$('[data-layer]').forEach(b => b.onclick = () => { S.mapLayer = b.dataset.layer; store.set('mapLayer', S.mapLayer); $$('[data-layer]').forEach(x => x.setAttribute('aria-pressed', x === b)); drawMap(); });
    $$('[data-mode]').forEach(b => b.onclick = () => { S.mapMode = b.dataset.mode; $$('[data-mode]').forEach(x => x.setAttribute('aria-pressed', x === b)); drawMap(); });
    if (matchMedia('(max-width: 520px)').matches) { S.mapMode = 'list'; $$('[data-mode]').forEach(x => x.setAttribute('aria-pressed', x.dataset.mode === 'list')); }
    const drawMap = async () => { await mapData(); $('#mapBox').innerHTML = S.mapMode === 'map' ? mapSvg(S.mapLayer) : stateTiles(S.mapLayer); $('#mapLegend').innerHTML = mapLegend(S.mapLayer); bindMap($('#mapBox')); };
    const drawSummary = () => {
      const s = S.summary; if (!s) return;
      $('#chambers').innerHTML = ['us_senate', 'us_house', 'governor'].filter(k => s.chambers[k]).map(k => chamberCard(k, s.chambers[k])).join('');
      $('#evMeta').innerHTML = `<span class="num">${s.counts.called} of ${s.counts.total} races called · ${s.counts.counting} counting · ${s.counts.no_results} awaiting results</span><span>${t('updated')} ${esc(fmtTime(s.generatedAt))}</span>`;
      const cr = S.event.rules?.closeRace || {};
      $('#closeDef').textContent = `Uncalled races within ${cr.competitiveMarginPts ?? 5} pts (very close: ${cr.veryCloseMarginPts ?? 1} pt or less)`;
      $('#closeBox').innerHTML = s.close.length ? `<div class="table-scroll"><table class="races"><thead><tr><th>Race</th><th>Leader</th><th class="n">Margin</th><th class="n">Reporting</th></tr></thead><tbody>${s.close.slice(0, 12).map(c => `<tr><td><a class="rl" href="#/e/${S.event.id}/race/${encodeURIComponent(c.id)}">${esc(c.label)}</a></td><td><span class="party-dot p-${esc(c.leader?.party)}"></span>${esc(c.leader?.name)}</td><td class="n close-${c.level}">${c.marginPts.toFixed(2)} pts<br><span class="small muted">${fmtN(c.marginVotes)} votes</span></td><td class="n" title="${esc(c.reporting?.definition || '')}">${c.reporting?.value != null ? fmtPct(c.reporting.value) : '—'}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">No uncalled race is within ${cr.competitiveMarginPts ?? 5} points yet.</div>`;
      if (S.mapData) drawMap();
    };
    const drawFeed = () => { $('#feedBox').innerHTML = feedList(S.feed.slice(0, 60)); };
    const drawKey = async () => {
      const list = await loadContests(true);
      const key = list.filter(c => ['us_senate', 'governor'].includes(c.office)).sort((a, b) => (a.decided - b.decided) || ((a.margin ? Math.abs(a.margin.pts) : 99) - (b.margin ? Math.abs(b.margin.pts) : 99))).slice(0, 12);
      $('#keyRaces').innerHTML = racesTable(key); bindFollow($('#keyRaces'));
    };
    drawSummary(); drawFeed(); drawMap(); drawKey();
    view = { onSummary: drawSummary, onFeed: drawFeed, onContests: drawKey };
  },

  async races(id, params) {
    await enterEvent(id);
    setCrumbs([{ label: t('home.title'), href: '#/' }, { label: S.event.shortName || S.event.name, href: `#/e/${id}` }, { label: t('races.title') }]);
    const p = Object.fromEntries(params);
    $('#main').innerHTML = `<div class="wrap"><div class="page-head"><div><h1>${t('races.title')}</h1><p class="muted small" id="raceCount"></p></div></div>
      <section class="panel"><div class="panel-head"><h2 class="sr-only">Filters</h2></div>
      <form class="filters" id="filters" role="search">
        <label class="sr-only" for="fq">Search</label><input id="fq" name="q" type="search" placeholder="Candidate, state or district" value="${esc(p.q || '')}">
        <label class="sr-only" for="fo">Office</label><select id="fo" name="office"><option value="">All offices</option><option value="us_senate">U.S. Senate</option><option value="us_house">U.S. House</option><option value="governor">Governor</option><option value="state_senate,state_house">State legislature</option><option value="lt_governor,attorney_general,secretary_of_state">Other statewide</option><option value="ballot_measure">Ballot measures</option><option value="mayor,local">Local</option></select>
        <label class="sr-only" for="fp">Party</label><select id="fp" name="party"><option value="">Any party</option><option value="DEM">Democratic</option><option value="REP">Republican</option><option value="IND">Independent</option><option value="LIB,GRN,OTH">Other parties</option></select>
        <label class="sr-only" for="fs">Status</label><select id="fs" name="status"><option value="">Any status</option><option value="called">Called (projected or certified)</option><option value="uncalled">Not called</option><option value="counting">Counting</option><option value="certified">Certified</option><option value="no_results">No results yet</option><option value="held,conflict">Held or conflicting</option></select>
        <label class="sr-only" for="fst">State</label><select id="fst" name="state"><option value="">All states</option>${(S.mapData?.states || []).map(s => `<option value="${s.abbr}">${esc(s.name)}</option>`).join('')}</select>
        <label class="sr-only" for="fsort">Sort</label><select id="fsort" name="sort"><option value="default">Sort: office and state</option><option value="competitive">Sort: most competitive</option><option value="margin">Sort: smallest margin</option><option value="reporting">Sort: most reported</option><option value="updated">Sort: latest update</option></select>
      </form><div id="raceTable"><div class="empty">Loading races…</div></div></section></div>`;
    await mapData();
    $('#fst').innerHTML = `<option value="">All states</option>${S.mapData.states.map(s => `<option value="${s.abbr}">${esc(s.name)}</option>`).join('')}`;
    for (const [k, v] of Object.entries(p)) { const el = $(`#filters [name="${k}"]`); if (el) el.value = v; }
    const draw = async () => {
      const fd = new URLSearchParams([...new FormData($('#filters'))].filter(([, v]) => v));
      history.replaceState(null, '', `#/e/${id}/races${fd.toString() ? '?' + fd : ''}`);
      fd.set('limit', '300');
      try {
        const r = await api(`/api/events/${id}/contests?${fd}`);
        $('#raceCount').textContent = `${r.total} race${r.total === 1 ? '' : 's'}${r.total > 300 ? ', showing the first 300' : ''}`;
        $('#raceTable').innerHTML = racesTable(r.contests); bindFollow($('#raceTable'));
      } catch (e) { $('#raceTable').innerHTML = `<div class="empty">Could not load races. ${esc(e.message)}</div>`; }
    };
    let deb; $('#filters').oninput = () => { clearTimeout(deb); deb = setTimeout(draw, 250); }; $('#filters').onsubmit = e => { e.preventDefault(); draw(); };
    draw();
    view = { onContests: draw };
  },

  async state(id, abbr) {
    await enterEvent(id); await mapData();
    const st = S.mapData.states.find(s => s.abbr === abbr);
    if (!st) { $('#main').innerHTML = `<div class="wrap empty">Unknown state “${esc(abbr)}”. <a href="#/e/${id}">Back to the map</a></div>`; return; }
    setCrumbs([{ label: t('home.title'), href: '#/' }, { label: S.event.shortName || S.event.name, href: `#/e/${id}` }, { label: st.name }]);
    const draw = async () => {
      const list = (await loadContests(true)).filter(c => c.jurisdiction.state === abbr);
      const statewide = list.filter(c => c.office !== 'us_house' && c.level !== 'local' && !['state_senate', 'state_house'].includes(c.office));
      const house = list.filter(c => c.office === 'us_house').sort((a, b) => (Number(a.jurisdiction.district) || 0) - (Number(b.jurisdiction.district) || 0));
      const other = list.filter(c => !statewide.includes(c) && !house.includes(c));
      const rules = S.event.rules || {};
      const notes = [rules.rankedChoice?.[abbr], rules.runoffRules?.[abbr]?.note, rules.redistricted2026?.includes(abbr) ? `${st.name} used new congressional district boundaries in 2026, so House results are not directly comparable with 2024 by district number.` : null].filter(Boolean);
      const followed = S.follows.has('state:' + abbr);
      $('#main').innerHTML = `<div class="wrap"><div class="page-head"><div><p class="eyebrow">${esc(S.event.shortName || S.event.name)}</p><h1>${esc(st.name)}</h1><p class="muted small num">${list.length} races · ${list.filter(c => c.decided).length} called</p></div>
        <button class="btn" id="followState" aria-pressed="${followed}">${followed ? `★ ${t('following')}` : `☆ Follow ${esc(st.name)}`}</button></div>
        ${notes.map(n => `<p class="callout" style="margin-bottom:12px">${esc(n)}</p>`).join('')}
        <div class="stack">
          <section class="panel"><div class="panel-head"><h2>Statewide races</h2></div>${statewide.length ? racesTable(statewide) : '<div class="empty">No statewide races from the enabled sources.</div>'}</section>
          <section class="panel"><div class="panel-head"><h2>U.S. House (${house.length} seat${house.length === 1 ? '' : 's'})</h2></div>${house.length ? racesTable(house) : '<div class="empty">No House results from the enabled sources.</div>'}</section>
          <section class="panel"><div class="panel-head"><h2>State legislature, ballot measures and local races</h2></div>${other.length ? racesTable(other) : `<div class="empty">None loaded for ${esc(st.name)}. These come from civicAPI's race search (an administrator setting) or an official state feed, once enabled.</div>`}</section>
        </div></div>`;
      $$('#main .panel').forEach(bindFollow);
      $('#followState').onclick = e => { toggleFollow('state:' + abbr, null); draw(); };
    };
    await draw(); view = { onContests: draw };
  },

  async race(id, cid) {
    await enterEvent(id);
    let data;
    const draw = async () => {
      try { data = await api(`/api/events/${id}/contests/${encodeURIComponent(cid)}`); } catch (e) { $('#main').innerHTML = `<div class="wrap empty">${esc(e.message)} <a href="#/e/${id}">Back</a></div>`; return; }
      const c = data.contest; const rules = S.event.rules || {};
      setCrumbs([{ label: t('home.title'), href: '#/' }, { label: S.event.shortName || S.event.name, href: `#/e/${id}` }, { label: c.jurisdiction.state, href: `#/e/${id}/state/${c.jurisdiction.state}` }, { label: raceLabel(c) }]);
      const tot = c.totalVotes || 0; const maxV = Math.max(1, ...c.candidates.map(x => x.votes || 0));
      const winnerCall = c.call || {};
      const notes = [rules.rankedChoice?.[c.jurisdiction.state], rules.runoffRules?.[c.jurisdiction.state] && c.office !== 'us_house' ? rules.runoffRules[c.jurisdiction.state].note : null,
        c.office === 'us_house' && rules.redistricted2026?.includes(c.jurisdiction.state) ? 'This state redrew its congressional districts for 2026. Comparisons with earlier results for the same district number are not like-for-like.' : null].filter(Boolean);
      const primary = c.sources?.find(s => s.primary);
      const callText = winnerCall.status === 'projected' || winnerCall.status === 'certified'
        ? `${winnerCall.status === 'certified' ? 'Certified' : 'Projected'} by ${esc(winnerCall.by)}${winnerCall.at ? ` at ${esc(fmtTime(winnerCall.at, true))}` : ''}${winnerCall.alsoCalledBy?.length ? `; also called by ${esc(winnerCall.alsoCalledBy.join(', '))}` : ''}${winnerCall.editorial ? ' (entered by an editor)' : ''}`
        : winnerCall.status === 'retracted' ? `A call for ${esc((winnerCall.previousWinners || []).join(', '))} by ${esc(winnerCall.by)} was withdrawn` : winnerCall.status === 'conflict' ? esc(winnerCall.note) : 'Not called. Leading candidates are not shown as winners.';
      $('#main').innerHTML = `<div class="wrap">
        <div class="page-head"><div><p class="eyebrow">${esc(c.officeLabel)} · ${esc(c.jurisdiction.name)}</p><h1>${esc(raceLabel(c))}</h1>
          <div class="row" style="margin-top:8px">${statusPill(c)}${c.flags?.includes('sample-data') ? '<span class="pill sample">Sample data</span>' : ''}<span class="small muted">${t('updated')} ${esc(fmtTime(c.updatedAt, true))}</span></div></div>
          <div class="row"><button class="btn" id="fol" aria-pressed="${S.follows.has(c.id)}">${S.follows.has(c.id) ? `★ ${t('following')}` : `☆ ${t('follow')}`}</button><button class="btn" id="copyLink">Copy link</button><button class="btn" id="shareImg">Save image</button></div></div>
        ${c.heldCounts ? `<p class="callout bad" style="margin-bottom:14px"><strong>Counts held.</strong> ${c.flags.includes('held:before-polls-close') ? 'Vote counts are not shown before polls close.' : c.flags.includes('held:editor') ? 'An editor is holding this race while a problem is checked.' : 'The latest figures failed a data check (for example more votes than residents) and are not shown until the source corrects them.'}</p>` : ''}
        ${winnerCall.status === 'retracted' || winnerCall.status === 'conflict' ? `<p class="callout bad" style="margin-bottom:14px">${callText}</p>` : ''}
        <div class="grid race-grid">
          <div class="stack">
            <section class="panel" aria-labelledby="candH"><div class="panel-head"><h2 id="candH">Results</h2><span class="small muted num">${tot ? `${fmtN(tot)} votes counted` : 'No votes reported yet'}</span></div>
              <div class="cands">${c.candidates.map(x => `<div class="cand ${x.winner ? 'won' : ''} ${x.winner && c.status === 'certified' ? 'cert' : ''}">
                <div><div class="name">${esc(x.name)}</div><div class="party"><span class="party-dot p-${esc(x.party)}"></span>${esc(x.partyLabel || PARTY[x.party])}${x.incumbent ? ' · Incumbent' : ''}</div></div>
                <div class="votes"><b>${x.pct != null && tot ? fmtPct(x.pct) : '—'}</b><br><span class="small muted">${fmtN(x.votes)}</span></div>
                <div class="track" aria-hidden="true"><span style="width:${tot ? ((x.votes || 0) / maxV) * 100 : 0}%;background:${pVar(x.party)}"></span></div></div>`).join('')}</div>
              ${c.margin && !c.heldCounts ? `<div class="note"><strong>${esc(c.candidates[0].name)}</strong> leads by <span class="num">${fmtN(c.margin.votes)}</span> votes (<span class="num">${c.margin.pts.toFixed(2)}</span> percentage points).</div>` : ''}
            </section>
            <section class="panel"><div class="panel-head"><h2>Results by area</h2><button class="btn" id="loadRegions">Load county results</button></div><div id="regions"><p class="empty">Loaded on request to limit calls to the data provider.</p></div></section>
            <section class="panel"><div class="panel-head"><h2>Earlier elections</h2></div>${c.history?.length ? `<div class="table-scroll"><table class="races"><thead><tr><th>Year</th><th>Result</th><th>Source</th></tr></thead><tbody>${c.history.map(h => `<tr><td class="num">${esc(h.year)}</td><td>${h.candidates.map(x => `${esc(x.name)} (${esc(x.party)}) ${fmtPct(x.pct)}`).join(' · ')}</td><td>${h.sourceUrl ? `<a href="${esc(h.sourceUrl)}" target="_blank" rel="noopener">${esc(h.source)}</a>` : esc(h.source)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="empty">No verified historical results are loaded for this race. Editors can import them (for example MIT Election Data and Science Lab files) from the admin panel.</p>`}</section>
          </div>
          <div class="stack">
            <section class="panel"><div class="panel-head"><h2>Race details</h2></div><dl class="facts">
              <dt>Office</dt><dd>${esc(c.officeLabel)}</dd>
              <dt>Area</dt><dd>${esc(c.jurisdiction.name)}${c.jurisdiction.district ? ` · District ${esc(c.jurisdiction.district)}` : ''}</dd>
              <dt>Race call</dt><dd>${callText}${winnerCall.sourceUrl && /^https?:/.test(winnerCall.sourceUrl) ? ` · <a href="${esc(winnerCall.sourceUrl)}" target="_blank" rel="noopener">source</a>` : ''}</dd>
              <dt>Reporting</dt><dd><span class="num">${esc(c.reporting?.label || 'Not reported')}</span><br><span class="small muted">${esc(c.reporting?.definition || '')}</span></dd>
              <dt>Data from</dt><dd>${(c.sources || []).map(s => `${s.url && /^https?:/.test(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}${s.primary ? ' <span class="pill">Shown</span>' : ''}${s.down ? ' <span class="pill held">Not responding</span>' : ''}<br><span class="small muted">Fetched ${esc(fmtTime(s.fetchedAt, true))}${s.sourceUpdatedAt ? ` · source updated ${esc(fmtTime(s.sourceUpdatedAt, true))}` : ''}</span>`).join('<br>')}</dd>
              ${c.override ? `<dt>Editor note</dt><dd>${esc(c.override.note || 'Edited')} — ${esc(c.override.actor)}, ${esc(fmtTime(c.override.at, true))}</dd>` : ''}
            </dl>
            ${c.discrepancies?.length ? `<div class="note"><strong>Sources disagree on counts:</strong><br>${c.discrepancies.map(d => `${esc(d.candidate)}: ${fmtN(d.primary.votes)} (${esc(d.primary.source)}) vs ${fmtN(d.other.votes)} (${esc(d.other.source)})`).join('<br>')}</div>` : ''}
            ${notes.map(n => `<div class="note">${esc(n)}</div>`).join('')}
            </section>
            <section class="panel"><div class="panel-head"><h2>Updates for this race</h2></div><div class="panel-body">${feedList(data.feed)}</div></section>
          </div>
        </div></div>`;
      $('#fol').onclick = e => toggleFollow(c.id, e.currentTarget);
      $('#copyLink').onclick = async e => { try { await navigator.clipboard.writeText(location.href); e.currentTarget.textContent = 'Link copied'; } catch { prompt('Copy this link', location.href); } };
      $('#shareImg').onclick = () => shareImage(c);
      $('#loadRegions').onclick = loadRegions;
    };
    const loadRegions = async () => {
      const box = $('#regions'); box.innerHTML = '<div class="panel-body"><div class="skeleton"></div></div>';
      try {
        const d = await api(`/api/events/${id}/contests/${encodeURIComponent(cid)}/detail`);
        if (!d.regions?.length) { box.innerHTML = `<p class="empty">${esc(d.note || 'The source has no sub-area results for this race.')}</p>`; return; }
        const names = data.contest.candidates.slice(0, 3).map(x => x.name);
        box.innerHTML = `<div class="table-scroll" style="max-height:420px"><table class="races"><thead><tr><th>Area</th>${names.map(n => `<th class="n">${esc(n.split(' ').slice(-1)[0])}</th>`).join('')}<th class="n">Reporting</th></tr></thead><tbody>${d.regions.map(r => `<tr><td>${esc(r.name)}</td>${names.map(n => { const x = r.candidates.find(y => y.name === n); return `<td class="n">${x ? `${fmtPct(x.pct)}<br><span class="small muted">${fmtN(x.votes)}</span>` : '—'}</td>`; }).join('')}<td class="n">${r.reporting != null ? fmtPct(r.reporting) : '—'}</td></tr>`).join('')}</tbody></table></div><p class="note">Source: ${esc(d.source)}${d.url ? ` (<a href="${esc(d.url)}" target="_blank" rel="noopener">raw data</a>)` : ''}. Fetched ${esc(fmtTime(d.fetchedAt))}. County shapes are not mapped yet because the source does not supply FIPS codes.</p>`;
      } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
    };
    await draw();
    view = { onContests: list => { if (list.some(x => x.id === cid)) draw(); }, onFeed: item => { if (item.contestId === cid) draw(); } };
  },

  async following() {
    setCrumbs([{ label: t('home.title'), href: '#/' }, { label: t('nav.following') }]);
    const events = await api('/api/events'); const ev = events.find(e => e.status === 'live') || events[0];
    if (ev) await enterEvent(ev.id);
    const list = ev ? (await loadContests(true)).filter(c => S.follows.has(c.id) || S.follows.has('state:' + c.jurisdiction.state)) : [];
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    $('#main').innerHTML = `<div class="wrap"><div class="page-head"><div><h1>${t('nav.following')}</h1><p class="muted">Races and states you follow are saved in this browser only.</p></div>
      <div class="row">${perm === 'default' ? '<button class="btn primary" id="askNotif">Allow browser notifications</button>' : `<span class="small muted">Browser notifications: ${perm === 'granted' ? 'on' : perm === 'denied' ? 'blocked in browser settings' : 'not supported'}</span>`}</div></div>
      <section class="panel">${list.length ? racesTable(list) : '<div class="empty">You are not following any races yet. Use ☆ next to a race, or “Follow” on a state page.</div>'}</section>
      <p class="small muted" style="margin-top:10px">Alerts fire while LiveDesk is open in a tab: race calls, withdrawn calls, conflicting calls and lead changes for what you follow. Each alert names its source.</p></div>`;
    bindFollow($('#main'));
    const a = $('#askNotif'); if (a) a.onclick = async () => { await Notification.requestPermission(); VIEWS.following(); };
    view = {};
  },

  async methodology() {
    setCrumbs([{ label: t('home.title'), href: '#/' }, { label: t('nav.methodology') }]);
    let ev = S.event; if (!ev) { const events = await api('/api/events'); ev = events.find(e => e.status === 'live') || events[0]; if (ev) await enterEvent(ev.id); }
    const s = S.summary; const r = ev?.rules || {};
    $('#main').innerHTML = `<div class="wrap prose">
      <p class="eyebrow">Methodology</p><h1>How LiveDesk reports results</h1>
      <p>LiveDesk collects results from the sources listed below, checks them, and shows each number with its source and the time it was fetched. Accuracy comes before speed. When something cannot be verified, it is left blank rather than estimated.</p>
      <h2>Sources in use</h2>
      <div class="table-scroll"><table class="src-table"><thead><tr><th>Source</th><th>Role</th><th>Refresh</th><th>Status</th><th>Licence</th></tr></thead><tbody>
      ${(s?.sourcesStatus || []).map(x => `<tr><td>${x.homepage ? `<a href="${esc(x.homepage)}" target="_blank" rel="noopener">${esc(x.name)}</a>` : esc(x.name)}</td><td>${esc(x.trust)}, priority ${x.priority}</td><td>${x.enabled ? `every ${x.intervalSec} s` : 'Off'}</td><td>${esc(x.health?.status || 'idle')}${x.health?.lastSuccess ? `<br><span class="small muted">last success ${esc(fmtTime(x.health.lastSuccess, true))}</span>` : ''}</td><td class="small">${esc(x.license || '')}</td></tr>`).join('')}
      </tbody></table></div>
      <h2>Race calls</h2>
      <ul><li>A candidate is shown as the winner only when a named source calls the race. LiveDesk never declares a winner because a candidate leads.</li>
      <li>When two sources call different winners, the race shows “conflicting calls” and no winner until they agree or an editor resolves it.</li>
      <li>If a source withdraws a call, the race is marked “call withdrawn” and a notice appears in the updates feed.</li>
      <li>“Certified” is used only when official certification is recorded by an official source or an editor citing it.</li>
      <li>civicAPI, the current free source, flags winners but does not publish how it makes calls. Treat its calls as unofficial projections.</li></ul>
      <h2>Counts and reporting</h2>
      <ul><li>Each race shows the reporting measure exactly as its source defines it. Precincts reporting is not the same as the share of votes counted, and the two are never converted into each other.</li>
      <li>Vote counts come from one source at a time (the highest-priority source that is responding), so votes are never added together across sources. Other sources are compared, and differences larger than ${r.discrepancyTolerancePct ?? 0.5}% are listed on the race page.</li>
      <li>Counts are held, not shown, when they fail a check: counts before polls close (before ${esc(fmtTime(r.countsHeldBefore, true))}), more votes than the area's 2020 Census population, negative votes, reporting outside 0–100%, or test data flagged by the source.</li>
      <li>If a source stops responding three times in a row, the next source in priority order takes over automatically and a banner warns readers.</li></ul>
      <h2>Close races and chamber control</h2>
      <ul><li>Close races are uncalled races with at least ${r.closeRace?.minReportingPct ?? 1}% reporting where the top two candidates are within ${r.closeRace?.competitiveMarginPts ?? 5} percentage points. “Very close” means ${r.closeRace?.veryCloseMarginPts ?? 1} point or less.</li>
      <li>Chamber totals add seats not up for election to races called by a named source. A party is shown with a majority only when those called seats reach the threshold (Senate ${r.chambers?.us_senate?.majority ?? 51}, House ${r.chambers?.us_house?.majority ?? 218}). ${esc(r.chambers?.us_senate?.tieNote || '')}</li>
      <li>Senate net change compares winners with the party (by caucus) holding each seat before the election. House and governor net change are not computed until a verified seat-by-seat list is loaded.</li></ul>
      <h2>Known limits</h2>
      <ul><li>The Associated Press and Decision Desk HQ feeds need paid licences. Adapters exist but are off.</li>
      <li>Official state and county feeds (Clarity/Civix and others) need one configuration per jurisdiction; an example slot is included.</li>
      <li>Congressional district maps for 2026 are not drawn yet: the Census Bureau had not published the 120th Congress boundary files when this was built, and ten states redrew their districts.</li>
      <li>Historical comparisons appear only where verified results have been imported.</li></ul>
      <h2>Corrections</h2><p>Every editor action (race calls entered by hand, holds, corrections, announcements, source changes) is recorded with the editor's name and time in an audit log.</p>
    </div>`;
    view = {};
  },

  async search(params) {
    const q = params.get('q') || '';
    setCrumbs([{ label: t('home.title'), href: '#/' }, { label: `Search: ${q}` }]);
    const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
    $('#main').innerHTML = `<div class="wrap"><h1 style="margin-bottom:14px">Results for “${esc(q)}”</h1>
      ${r.events.length ? `<div class="grid events" style="margin-bottom:16px">${r.events.map(e => `<a class="panel event-card" href="#/e/${esc(e.id)}"><h2>${esc(e.name)}</h2></a>`).join('')}</div>` : ''}
      <section class="panel">${r.contests.length ? racesTable(r.contests.map(c => ({ ...c })), { showFollow: false }) : '<div class="empty">Nothing found.</div>'}</section></div>`;
    view = {};
  }
};

async function enterEvent(id) {
  if (S.event?.id !== id) {
    S.event = await api(`/api/events/${encodeURIComponent(id)}`);
    S.summary = await api(`/api/events/${encodeURIComponent(id)}/summary`);
    S.feed = await api(`/api/events/${encodeURIComponent(id)}/feed?limit=100`);
    S.contests = null;
    document.title = `${S.event.shortName || S.event.name} · LiveDesk`;
  }
  setBanner(); setFootSources(); connect(id);
}

async function shareImage(c) {
  const W = 1200, H = 630, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
  const cs = getComputedStyle(document.documentElement); const col = v => cs.getPropertyValue(v).trim();
  g.fillStyle = col('--surface'); g.fillRect(0, 0, W, H);
  g.fillStyle = col('--ink'); g.font = '800 52px "Public Sans", sans-serif'; g.fillText(raceLabel(c), 60, 110);
  g.font = '600 26px "Public Sans", sans-serif'; g.fillStyle = col('--muted');
  g.fillText(`${t('status.' + c.status)} · ${c.reporting?.label || ''} · ${c.call?.by ? 'Call: ' + c.call.by : 'Not called'}`, 60, 158);
  const tot = c.totalVotes || 0; let y = 220;
  for (const x of c.candidates.slice(0, 4)) {
    g.fillStyle = col('--ink'); g.font = '700 30px "Public Sans", sans-serif'; g.fillText(`${x.winner ? '✓ ' : ''}${x.name} (${x.party})`, 60, y);
    g.font = '600 30px "IBM Plex Mono", monospace'; const v = tot ? `${x.pct?.toFixed(1)}%  ${fmtN(x.votes)}` : '—'; g.fillText(v, W - 60 - g.measureText(v).width, y);
    g.fillStyle = col('--none'); g.fillRect(60, y + 14, W - 120, 18);
    g.fillStyle = { DEM: col('--dem'), REP: col('--rep'), IND: col('--ind') }[x.party] || col('--oth'); g.fillRect(60, y + 14, tot ? (W - 120) * (x.votes / tot) : 0, 18);
    y += 92;
  }
  g.fillStyle = col('--muted'); g.font = '500 22px "Public Sans", sans-serif';
  g.fillText(`${c.flags?.includes('sample-data') ? 'SAMPLE DATA — NOT REAL RESULTS · ' : ''}Source: ${c.sources?.find(s => s.primary)?.name || '—'} · ${fmtTime(c.updatedAt, true)} · Unofficial until certified`, 60, H - 40);
  cv.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${c.id.replace(/[^a-z0-9-]+/gi, '_')}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });
}

// ---------- router ----------
async function route() {
  view = {}; $('#tooltip').hidden = true;
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(qs || ''); const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (!parts.length) await VIEWS.home();
    else if (parts[0] === 'methodology') await VIEWS.methodology();
    else if (parts[0] === 'following') await VIEWS.following();
    else if (parts[0] === 'search') await VIEWS.search(params);
    else if (parts[0] === 'e' && parts[1]) {
      if (!parts[2]) await VIEWS.event(parts[1]);
      else if (parts[2] === 'races') await VIEWS.races(parts[1], params);
      else if (parts[2] === 'state') await VIEWS.state(parts[1], (parts[3] || '').toUpperCase());
      else if (parts[2] === 'race') await VIEWS.race(parts[1], parts.slice(3).join('/'));
    } else await VIEWS.home();
  } catch (e) {
    $('#main').innerHTML = `<div class="wrap empty">Something went wrong loading this page: ${esc(e.message)}. <a href="#/">Go to the start page</a></div>`;
  }
  if (!location.hash.includes('/races')) window.scrollTo(0, 0);
}
addEventListener('hashchange', route);
route();
setInterval(() => { if (view.onSummary && S.summary) view.onSummary(); }, 60000); // keep relative times fresh
