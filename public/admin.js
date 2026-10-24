// ============================================================
// ADMIN DASHBOARD — monitoring and managing the system
// ============================================================

const $ = (id) => document.getElementById(id);
const COLORS = { Critical: '#c0262d', High: '#d9701a', Medium: '#b8960b', Low: '#2e8b57' };
let adminKey = sessionStorage.getItem('adminKey') || '';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt = (ts) => new Date(ts + 'Z').toLocaleString();

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey, ...(options.headers || {}) },
  });
  const data = await res.json();
  if (res.status === 401) { logout(); throw new Error('Invalid admin key'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---------- Login ----------
async function login() {
  adminKey = $('adminKey').value.trim() || adminKey;
  try {
    await api('/api/admin/stats');
    sessionStorage.setItem('adminKey', adminKey);
    $('loginCard').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    $('logoutBtn').classList.remove('hidden');
    refresh();
  } catch (e) {
    $('loginError').textContent = e.message;
  }
}
function logout() {
  sessionStorage.removeItem('adminKey');
  adminKey = '';
  $('dashboard').classList.add('hidden');
  $('logoutBtn').classList.add('hidden');
  $('loginCard').classList.remove('hidden');
}
$('loginBtn').addEventListener('click', login);
$('adminKey').addEventListener('keydown', (e) => e.key === 'Enter' && login());
$('logoutBtn').addEventListener('click', (e) => { e.preventDefault(); logout(); });

// ---------- Render helpers ----------
function bars(el, items, max) {
  if (!items.length) { el.innerHTML = '<div class="empty" style="padding:20px">No data yet.</div>'; return; }
  const top = max || Math.max(...items.map((i) => i.n), 1);
  el.innerHTML = items.map((i) => `
    <div class="bar">
      <span>${escapeHtml(i.label)}</span>
      <div class="track"><div class="fill" style="width:${(i.n / top) * 100}%;background:${i.color || 'var(--brand)'}"></div></div>
      <strong>${i.n}</strong>
    </div>`).join('');
}

async function loadStats() {
  const s = await api('/api/admin/stats');
  $('stats').innerHTML = `
    <div class="stat"><div class="n">${s.total}</div><div class="l">Total workflows processed</div></div>
    <div class="stat"><div class="n">${s.today}</div><div class="l">Processed today</div></div>
    <div class="stat"><div class="n">${s.open}</div><div class="l">Open (not yet reviewed)</div></div>
    <div class="stat ${s.openCritical ? 'alert' : ''}"><div class="n">${s.openCritical}</div><div class="l">Open critical cases</div></div>
    <div class="stat"><div class="n">${s.avgRiskScore}</div><div class="l">Average risk score</div></div>
    <div class="stat"><div class="n">${s.avgProcessingMs} ms</div><div class="l">Average processing time</div></div>
    <div class="stat ${s.errors ? 'alert' : ''}"><div class="n">${s.errors}</div><div class="l">Errors / fallbacks logged</div></div>
    <div class="stat"><div class="n" style="font-size:16px;padding-top:8px">${s.bySource.map((b) => `${escapeHtml(b.source)}: ${b.n}`).join('<br>') || '—'}</div><div class="l">AI engine usage</div></div>`;

  bars($('priorityBars'), ['Critical', 'High', 'Medium', 'Low'].map((p) => ({ label: p, n: s.byPriority[p] || 0, color: COLORS[p] })));
  bars($('riskBars'), s.topRisks.map((r) => ({ label: r.category, n: r.n })));
  bars($('dayBars'), s.last7Days.map((d) => ({ label: d.day, n: d.n })));

  $('activityLog').innerHTML = s.recentActivity.map((a) =>
    `<div class="${a.success ? '' : 'fail'}">${fmt(a.created_at)} — <strong>${escapeHtml(a.event)}</strong> ${escapeHtml(a.detail || '')}</div>`
  ).join('') || '<div>No activity yet.</div>';
}

async function loadTable() {
  const params = new URLSearchParams();
  if ($('fSearch').value) params.set('q', $('fSearch').value);
  if ($('fPriority').value) params.set('priority', $('fPriority').value);
  if ($('fStatus').value) params.set('status', $('fStatus').value);
  const rows = await api(`/api/admin/summaries?${params}`);

  $('tableBody').innerHTML = rows.length ? rows.map((r) => `
    <tr>
      <td>${r.id}</td>
      <td>${fmt(r.created_at)}</td>
      <td>${escapeHtml(r.patient_ref || '—')}</td>
      <td><span class="badge ${r.priority}">${r.priority}</span></td>
      <td>${r.risk_score}</td>
      <td>${escapeHtml(r.ai_source)}</td>
      <td><span class="status-pill ${r.status}">${r.status}</span></td>
      <td style="white-space:nowrap">
        <button class="ghost small" data-view="${r.id}">View</button>
        <button class="ghost small" data-toggle="${r.id}" data-status="${r.status}">${r.status === 'open' ? 'Mark reviewed' : 'Reopen'}</button>
        <button class="danger small" data-del="${r.id}">Delete</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty">No workflows match.</td></tr>';

  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => showDetail(rows.find((r) => r.id == b.dataset.view))));
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/admin/summaries/${b.dataset.toggle}`, { method: 'PATCH', body: JSON.stringify({ status: b.dataset.status === 'open' ? 'reviewed' : 'open' }) });
    refresh();
  }));
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Delete summary #${b.dataset.del}? This cannot be undone.`)) return;
    await api(`/api/admin/summaries/${b.dataset.del}`, { method: 'DELETE' });
    refresh();
  }));
}

function showDetail(r) {
  $('modal').innerHTML = `
    <div class="result-head">
      <h2>Summary #${r.id}</h2>
      <span class="badge ${r.priority}">${r.priority} · ${r.risk_score}/100</span>
    </div>
    <div class="reason">${fmt(r.created_at)} · ${escapeHtml(r.patient_ref || 'No patient ref')} · ${escapeHtml(r.author || 'Unknown author')} · ${escapeHtml(r.ai_source)} · ${r.processing_ms} ms</div>
    <div class="section"><h3>Risk flags</h3><div class="chips">${r.risk_flags.map((f) => `<span class="chip ${f.level}">${escapeHtml(f.category)}: ${escapeHtml(f.keywords.join(', '))} (+${f.weight})</span>`).join('') || 'None'}</div></div>
    <div class="section"><h3>Summary</h3><p>${escapeHtml(r.summary)}</p></div>
    <div class="section"><h3>Key points</h3><ul>${r.key_points.map((k) => `<li>${escapeHtml(k)}</li>`).join('')}</ul></div>
    <div class="section"><h3>Next steps</h3><ul>${r.next_steps.map((k) => `<li>${escapeHtml(k)}</li>`).join('')}</ul></div>
    <div class="section"><h3>Original note</h3><pre>${escapeHtml(r.note_text)}</pre></div>
    <div class="actions"><button id="closeModal">Close</button></div>`;
  $('modalBg').classList.add('open');
  $('closeModal').addEventListener('click', () => $('modalBg').classList.remove('open'));
}
$('modalBg').addEventListener('click', (e) => e.target === $('modalBg') && $('modalBg').classList.remove('open'));

function refresh() { loadStats().catch(console.error); loadTable().catch(console.error); }

let searchTimer;
$('fSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadTable, 300); });
$('fPriority').addEventListener('change', loadTable);
$('fStatus').addEventListener('change', loadTable);
$('refreshBtn').addEventListener('click', refresh);

// Auto-refresh every 30 seconds while the dashboard is open
setInterval(() => { if (!$('dashboard').classList.contains('hidden')) refresh(); }, 30000);

if (adminKey) login();
