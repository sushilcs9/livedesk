const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let token = sessionStorage.getItem('ld-admin') || '';
let me = null, events = [], ev = null, contests = [];

async function call(method, path, body) {
  const r = await fetch(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
const msg = (id, text, ok = true) => { const el = $(id); el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); };

async function signIn() {
  try { me = await call('GET', '/api/admin/whoami'); } catch (e) { msg('#loginMsg', e.message, false); return; }
  sessionStorage.setItem('ld-admin', token);
  $('#loginBox').hidden = true; $('#app').hidden = false;
  $('#who').innerHTML = `${esc(me.name)} · <strong>${esc(me.role)}</strong> · <a href="#" id="out">Sign out</a>`;
  $('#out').onclick = e => { e.preventDefault(); sessionStorage.removeItem('ld-admin'); location.reload(); };
  events = await (await fetch('/api/events')).json();
  $('#eventSel').innerHTML = events.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
  $('#eventSel').onchange = () => loadEvent($('#eventSel').value);
  loadEvent(events[0]?.id);
}
$('#login').onsubmit = e => { e.preventDefault(); token = $('#token').value.trim(); signIn(); };
if (token) signIn();

async function loadEvent(id) {
  if (!id) return;
  ev = await (await fetch(`/api/events/${id}`)).json();
  const sum = await (await fetch(`/api/events/${id}/summary`)).json();
  contests = (await (await fetch(`/api/events/${id}/contests?limit=5000`)).json()).contests;
  $('#evStatus').value = ev.status; $('#evName').value = ev.name;
  $('#raceList').innerHTML = contests.map(c => `<option value="${esc(c.id)}">${esc(c.jurisdiction.name)} ${esc(c.officeLabel)}</option>`).join('');
  const health = Object.fromEntries(sum.sourcesStatus.map(s => [s.id, s.health]));
  $('#srcTable').innerHTML = `<thead><tr><th>Source</th><th>On</th><th class="n">Priority</th><th class="n">Every (s)</th><th>Health</th><th></th></tr></thead><tbody>${ev.sources.map(s => `<tr class="src-row" data-id="${esc(s.id)}">
    <td><strong>${esc(s.name)}</strong><br><span class="small muted">${esc(s.trust)} · ${esc(s.license || '')}</span></td>
    <td><input type="checkbox" data-f="enabled" ${s.enabled ? 'checked' : ''} aria-label="Enable ${esc(s.name)}"></td>
    <td class="n"><input type="number" data-f="priority" value="${s.priority}" aria-label="Priority"></td>
    <td class="n"><input type="number" min="15" data-f="intervalSec" value="${s.intervalSec}" aria-label="Refresh interval"></td>
    <td class="small">${esc(health[s.id]?.status || 'idle')}${health[s.id]?.lastError ? `<br><span class="muted">${esc(health[s.id].lastError)}</span>` : ''}</td>
    <td><div class="row"><button class="btn" data-a="save">Save</button><button class="btn" data-a="run">Fetch now</button></div></td></tr>`).join('')}</tbody>`;
  document.querySelectorAll('.src-row').forEach(row => {
    row.querySelector('[data-a=save]').onclick = async () => {
      const patch = { enabled: row.querySelector('[data-f=enabled]').checked, priority: Number(row.querySelector('[data-f=priority]').value), intervalSec: Number(row.querySelector('[data-f=intervalSec]').value) };
      try { await call('PATCH', `/api/admin/events/${ev.id}/sources/${row.dataset.id}`, patch); msg('#srcMsg', `Saved ${row.dataset.id}. The schedule restarted with the new settings.`); loadEvent(ev.id); } catch (e) { msg('#srcMsg', e.message, false); }
    };
    row.querySelector('[data-a=run]').onclick = async () => {
      try { const r = await call('POST', `/api/admin/events/${ev.id}/sources/${row.dataset.id}/run`); msg('#srcMsg', r.ok ? `Fetched ${row.dataset.id}.` : `Fetch failed; see health column.`, r.ok); loadEvent(ev.id); } catch (e) { msg('#srcMsg', e.message, false); }
    };
  });
}
$('#saveEv').onclick = async () => {
  try { await call('PATCH', `/api/admin/events/${ev.id}`, { status: $('#evStatus').value, name: $('#evName').value }); msg('#evMsg', 'Event saved.'); } catch (e) { msg('#evMsg', e.message, false); }
};
$('#ovrRace').oninput = () => {
  const c = contests.find(x => x.id === $('#ovrRace').value);
  $('#ovrWinner').innerHTML = c ? c.candidates.map(x => `<option value="${esc(x.id)}">${esc(x.name)} (${esc(x.party)})</option>`).join('') : '';
};
$('#ovr').onsubmit = async e => {
  e.preventDefault();
  const cid = $('#ovrRace').value, action = $('#ovrAction').value, path = `/api/admin/events/${ev.id}/contests/${encodeURIComponent(cid)}/override`;
  try {
    if (action === 'clear') await call('DELETE', path);
    else if (action === 'hold') await call('POST', path, { hold: true, note: $('#ovrNote').value || null });
    else await call('POST', path, { call: { status: action, winnerIds: [...$('#ovrWinner').selectedOptions].map(o => o.value), by: $('#ovrBy').value, sourceUrl: $('#ovrUrl').value }, note: $('#ovrNote').value || null });
    msg('#ovrMsg', 'Applied and recorded in the audit log.');
  } catch (err) { msg('#ovrMsg', err.message, false); }
};
$('#ann').onsubmit = async e => {
  e.preventDefault();
  try { await call('POST', `/api/admin/events/${ev.id}/announcements`, { title: $('#annTitle').value, source: $('#annSource').value, sourceUrl: $('#annUrl').value || null, kind: $('#annKind').value }); msg('#annMsg', 'Published.'); e.target.reset(); } catch (err) { msg('#annMsg', err.message, false); }
};
$('#up').onsubmit = async e => {
  e.preventDefault();
  let payload; try { payload = JSON.parse($('#upJson').value); } catch { msg('#upMsg', 'That is not valid JSON.', false); return; }
  try { const r = await call('POST', `/api/admin/events/${ev.id}/upload`, payload); msg('#upMsg', `Received ${r.received} races; ${r.published} changed on the site.`); } catch (err) { msg('#upMsg', err.message, false); }
};
$('#newEv').onsubmit = async e => {
  e.preventDefault();
  let cfg; try { cfg = JSON.parse($('#newEvJson').value); } catch { msg('#newEvMsg', 'That is not valid JSON.', false); return; }
  try { await call('POST', '/api/admin/events', cfg); msg('#newEvMsg', `Created ${cfg.id}.`); } catch (err) { msg('#newEvMsg', err.message, false); }
};
$('#loadAudit').onclick = async () => {
  try {
    const rows = await call('GET', '/api/admin/audit');
    $('#audit').innerHTML = rows.length ? `<div class="table-scroll"><table class="races"><thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Target</th><th>Change</th></tr></thead><tbody>${rows.map(r => `<tr><td class="num small">${esc(r.at)}</td><td>${esc(r.actor)} (${esc(r.role)})</td><td>${esc(r.action)}</td><td class="small">${esc(r.target)}</td><td class="small num" style="max-width:420px;overflow-wrap:anywhere">${esc(JSON.stringify(r.after))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No actions yet.</p>';
  } catch (err) { $('#audit').innerHTML = `<p class="empty">${esc(err.message)}</p>`; }
};
