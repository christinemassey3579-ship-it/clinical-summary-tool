// ============================================================
// FRONTEND — user screen
// Sends the note to the backend and renders the structured output.
// ============================================================

const SAMPLES = {
  critical: `72M, post-op day 2 after bowel resection. At 03:00 complains of chest pain radiating to the left arm, sweating. BP 88/54, HR 124, SpO2 91% on room air. Appears anxious. History of hypertension and type 2 diabetes. Night doctor not yet informed.`,
  high: `81F, admitted with UTI. Found on the floor beside the bed at 05:30 after an unwitnessed fall. Now confused and disoriented to time and place (was orientated yesterday). Temp 38.6C, HR 104, BP 132/80. Poor intake over the last 2 days. Small graze to right forearm, dressed.`,
  medium: `45F, day 2 of IV antibiotics for cellulitis of the left lower leg. Temp 38.2C, HR 92, BP 124/78. Denies chest pain or shortness of breath. Redness margin marked yesterday and slightly reduced today. Mild swelling, pain 4/10, managed with regular analgesia. Eating and drinking well.`,
  low: `30M, day 1 after laparoscopic appendicectomy. No fever, no nausea. Pain well controlled. Eating and drinking normally, mobilising independently. Wound clean and dry. Plan for discharge tomorrow morning if bloods are stable.`,
};

const $ = (id) => document.getElementById(id);
const noteEl = $('note');
const priorityColors = { Critical: '#c0262d', High: '#d9701a', Medium: '#b8960b', Low: '#2e8b57' };
let lastResult = null;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Pipeline animation ----------
function setPipeline(step) {
  document.querySelectorAll('#pipeline .step').forEach((el) => {
    el.classList.toggle('on', Number(el.dataset.step) <= step);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Input helpers ----------
noteEl.addEventListener('input', () => ($('count').textContent = noteEl.value.length));
document.querySelectorAll('[data-sample]').forEach((btn) =>
  btn.addEventListener('click', () => {
    noteEl.value = SAMPLES[btn.dataset.sample];
    $('count').textContent = noteEl.value.length;
    $('error').textContent = '';
  })
);
$('clearBtn').addEventListener('click', () => {
  noteEl.value = '';
  $('patientRef').value = '';
  $('count').textContent = 0;
  $('error').textContent = '';
  setPipeline(0);
});

// ---------- Submit ----------
$('submitBtn').addEventListener('click', async () => {
  const note = noteEl.value.trim();
  $('error').textContent = '';
  if (note.length < 20) {
    $('error').textContent = 'Please enter a clinical note of at least 20 characters.';
    return;
  }

  const btn = $('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Processing...';
  setPipeline(1);

  try {
    await wait(150); setPipeline(2);
    const reqPromise = fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note, patientRef: $('patientRef').value, author: $('author').value }),
    });
    await wait(150); setPipeline(3);
    const res = await reqPromise;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    setPipeline(4); await wait(200);
    setPipeline(5); await wait(200);
    setPipeline(6);
    renderResult(data);
    loadHistory();
  } catch (err) {
    $('error').textContent = err.message;
    setPipeline(0);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate summary';
  }
});

// ---------- Render the structured output ----------
function renderResult(r) {
  lastResult = r;
  $('emptyState').classList.add('hidden');
  $('result').classList.remove('hidden');

  $('rId').textContent = `#${r.id}`;
  $('rMeta').textContent = [
    r.patient_ref ? `Patient: ${r.patient_ref}` : null,
    r.author ? `By: ${r.author}` : null,
    `Engine: ${r.ai_source}`,
    `${r.processing_ms} ms`,
  ].filter(Boolean).join(' · ');

  const badge = $('rPriority');
  badge.className = `badge ${r.priority}`;
  badge.textContent = `${r.priority.toUpperCase()} PRIORITY`;

  $('rScore').textContent = `${r.risk_score} / 100`;
  $('rFill').style.width = `${r.risk_score}%`;
  $('rFill').style.background = priorityColors[r.priority];
  $('rReason').textContent = r.reasoning || '';

  const flags = r.risk_flags || [];
  $('flagsSection').classList.toggle('hidden', flags.length === 0);
  $('rFlags').innerHTML = flags
    .map((f) => `<span class="chip ${f.level}">${escapeHtml(f.category)}: ${escapeHtml(f.keywords.join(', '))}</span>`)
    .join('');

  $('rSummary').textContent = r.summary;
  $('rKeyPoints').innerHTML = r.key_points.map((k) => `<li>${escapeHtml(k)}</li>`).join('');
  $('rNextSteps').innerHTML = r.next_steps.map((k) => `<li>${escapeHtml(k)}</li>`).join('');
  $('rDisclaimer').textContent = r.disclaimer || '';
}

$('copyBtn').addEventListener('click', async () => {
  if (!lastResult) return;
  const r = lastResult;
  const text = [
    `HANDOFF SUMMARY #${r.id}${r.patient_ref ? ' — ' + r.patient_ref : ''}`,
    `Priority: ${r.priority} (risk score ${r.risk_score}/100)`,
    '',
    `Summary: ${r.summary}`,
    '',
    'Key points:', ...r.key_points.map((k) => `- ${k}`),
    '',
    'Next steps:', ...r.next_steps.map((k) => `- ${k}`),
    '',
    r.disclaimer,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('copyBtn').textContent = 'Copied';
    setTimeout(() => ($('copyBtn').textContent = 'Copy handoff text'), 1500);
  } catch {
    alert(text);
  }
});

// ---------- History ----------
async function loadHistory() {
  try {
    const rows = await (await fetch('/api/summaries?limit=10')).json();
    const body = $('historyBody');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty">No summaries yet.</td></tr>';
      return;
    }
    body.innerHTML = rows.map((r) => `
      <tr class="clickable" data-id="${r.id}">
        <td>${r.id}</td>
        <td>${new Date(r.created_at + 'Z').toLocaleString()}</td>
        <td>${escapeHtml(r.patient_ref || '—')}</td>
        <td><span class="badge ${r.priority}">${r.priority}</span></td>
        <td>${r.risk_score}</td>
        <td>${escapeHtml((r.summary || '').slice(0, 90))}${(r.summary || '').length > 90 ? '…' : ''}</td>
      </tr>`).join('');
    body.querySelectorAll('tr[data-id]').forEach((tr) =>
      tr.addEventListener('click', async () => {
        const data = await (await fetch(`/api/summaries/${tr.dataset.id}`)).json();
        renderResult(data);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      })
    );
  } catch (e) {
    console.error(e);
  }
}

loadHistory();
