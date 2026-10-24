// ============================================================
// CLINICAL SUMMARY TOOL — BACKEND API
// Flow: Input -> Validate -> AI Generation -> Smart Logic Layer
//       -> Database -> Structured Output (+ Admin monitoring)
// ============================================================

require('dotenv').config();
const express = require('express');
const path = require('path');
const { generateSummary } = require('./src/ai');
const { analyzeRisk } = require('./src/logic');
const db = require('./src/db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';

const DISCLAIMER = 'Non-diagnostic summary for handoff support only. Always verify against the original record and use clinical judgement.';

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Health check ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ai_mode: process.env.ANTHROPIC_API_KEY ? 'claude' : 'rule-based', time: new Date().toISOString() });
});

// ---------- MAIN WORKFLOW: process a clinical note ----------
app.post('/api/summarize', async (req, res) => {
  const started = Date.now();
  const note = String(req.body.note || '').trim();
  const patientRef = String(req.body.patientRef || '').trim().slice(0, 40) || null;
  const author = String(req.body.author || '').trim().slice(0, 60) || null;

  // 1. Validate input
  if (note.length < 20) {
    db.logEvent('summarize_rejected', 'Note too short', false);
    return res.status(400).json({ error: 'Please enter a clinical note of at least 20 characters.' });
  }
  if (note.length > 10000) {
    db.logEvent('summarize_rejected', 'Note too long', false);
    return res.status(400).json({ error: 'Note is too long (max 10,000 characters).' });
  }

  try {
    // Pipeline trace: records how long each stage took, shown in the UI
    const trace = [{ stage: 'Backend API', detail: 'Input validated', ms: Date.now() - started }];
    let t = Date.now();

    // 2. AI generation (Claude, or rule-based fallback)
    const ai = await generateSummary(note);
    trace.push({ stage: 'AI generation', detail: ai.ai_source, ms: Date.now() - t });
    t = Date.now();

    // 3. Smart logic layer (risk keywords, vitals, score, priority, actions)
    const risk = analyzeRisk(note);
    trace.push({ stage: 'Smart logic', detail: `${risk.risk_flags.length} flags → ${risk.priority}`, ms: Date.now() - t });
    t = Date.now();

    // 4. Merge: rule-based safety actions first, then AI steps, no duplicates.
    //    Each step keeps its source so the UI can show what the logic layer added.
    const seen = new Set();
    const nextSteps = [
      ...risk.suggested_actions.map((text) => ({ text, source: 'rule' })),
      ...ai.next_steps.map((text) => ({ text, source: ai.ai_source === 'claude' ? 'ai' : 'summarizer' })),
    ].filter((s) => {
      const k = s.text.toLowerCase().trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 8);

    // 5. Store in database
    const saved = db.saveSummary({
      patient_ref: patientRef,
      author,
      note_text: note,
      summary: ai.summary,
      key_points: ai.key_points,
      next_steps: nextSteps,
      priority: risk.priority,
      risk_score: risk.risk_score,
      risk_flags: risk.risk_flags,
      ai_source: ai.ai_source,
      processing_ms: Date.now() - started,
    });

    trace.push({ stage: 'Database', detail: `Saved as #${saved.id}`, ms: Date.now() - t });

    db.logEvent('summary_created', `#${saved.id} ${risk.priority} (score ${risk.risk_score}) via ${ai.ai_source}`, true);
    if (ai.ai_error) db.logEvent('ai_fallback', ai.ai_error, false);

    // 6. Structured output
    res.json({ ...saved, reasoning: risk.reasoning, trace, disclaimer: DISCLAIMER });
  } catch (err) {
    console.error(err);
    db.logEvent('summarize_error', err.message, false);
    res.status(500).json({ error: 'Something went wrong while processing the note.' });
  }
});

// ---------- Recent history for the user screen ----------
app.get('/api/summaries', (req, res) => {
  const rows = db.listSummaries({ limit: req.query.limit || 10 })
    .map(({ id, created_at, patient_ref, priority, risk_score, summary }) => ({ id, created_at, patient_ref, priority, risk_score, summary }));
  res.json(rows);
});

app.get('/api/summaries/:id', (req, res) => {
  const row = db.getSummary(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ...row, reasoning: analyzeRisk(row.note_text).reasoning, disclaimer: DISCLAIMER });
});

// ---------- ADMIN (protected by a simple key) ----------
function requireAdmin(req, res, next) {
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
  next();
}

app.get('/api/admin/stats', requireAdmin, (req, res) => res.json(db.getStats()));

app.get('/api/admin/summaries', requireAdmin, (req, res) => {
  const { priority, status, q, limit } = req.query;
  res.json(db.listSummaries({ priority, status, q, limit: limit || 100 }));
});

// Export all workflows as a CSV file (opens in Excel / Google Sheets)
app.get('/api/admin/export', requireAdmin, (req, res) => {
  const rows = db.listSummaries({ limit: 500 });
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['id', 'created_at', 'patient_ref', 'author', 'priority', 'risk_score', 'status', 'ai_source', 'summary', 'risk_flags', 'next_steps'];
  const lines = rows.map((r) => [
    r.id, r.created_at, r.patient_ref, r.author, r.priority, r.risk_score, r.status, r.ai_source, r.summary,
    r.risk_flags.map((f) => `${f.category}: ${f.keywords.join('/')}`).join('; '),
    r.next_steps.map((s) => (typeof s === 'string' ? s : s.text)).join('; '),
  ].map(cell).join(','));
  db.logEvent('export_csv', `${rows.length} rows`, true);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="clinical-summaries.csv"');
  res.send([header.join(','), ...lines].join('\n'));
});

app.patch('/api/admin/summaries/:id', requireAdmin, (req, res) => {
  const status = req.body.status;
  if (!['open', 'reviewed'].includes(status)) return res.status(400).json({ error: 'Status must be open or reviewed' });
  const ok = db.updateStatus(Number(req.params.id), status);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  db.logEvent('status_changed', `#${req.params.id} -> ${status}`, true);
  res.json({ ok: true });
});

app.delete('/api/admin/summaries/:id', requireAdmin, (req, res) => {
  const ok = db.deleteSummary(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Not found' });
  db.logEvent('summary_deleted', `#${req.params.id}`, true);
  res.json({ ok: true });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Clinical Summary Tool running on port ${PORT}`);
  console.log(`AI mode: ${process.env.ANTHROPIC_API_KEY ? 'Claude' : 'rule-based (add ANTHROPIC_API_KEY to use Claude)'}`);
});
