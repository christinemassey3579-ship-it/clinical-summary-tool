// ============================================================
// DATABASE LAYER (SQLite — a single file, no setup needed)
// Stores every processed summary + an activity log for the
// admin dashboard. The file lives at data/clinical.db
// ============================================================

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(process.env.DB_PATH || path.join(dataDir, 'clinical.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    patient_ref TEXT,
    author TEXT,
    note_text TEXT NOT NULL,
    summary TEXT,
    key_points TEXT,       -- JSON array
    next_steps TEXT,       -- JSON array
    priority TEXT,
    risk_score INTEGER,
    risk_flags TEXT,       -- JSON array
    ai_source TEXT,
    processing_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'open'   -- open | reviewed
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    event TEXT NOT NULL,
    detail TEXT,
    success INTEGER NOT NULL DEFAULT 1
  );
`);

function rowToObject(row) {
  if (!row) return null;
  return {
    ...row,
    key_points: JSON.parse(row.key_points || '[]'),
    next_steps: JSON.parse(row.next_steps || '[]'),
    risk_flags: JSON.parse(row.risk_flags || '[]'),
  };
}

function saveSummary(rec) {
  const info = db.prepare(`
    INSERT INTO summaries (patient_ref, author, note_text, summary, key_points, next_steps,
      priority, risk_score, risk_flags, ai_source, processing_ms)
    VALUES (@patient_ref, @author, @note_text, @summary, @key_points, @next_steps,
      @priority, @risk_score, @risk_flags, @ai_source, @processing_ms)
  `).run({
    ...rec,
    key_points: JSON.stringify(rec.key_points),
    next_steps: JSON.stringify(rec.next_steps),
    risk_flags: JSON.stringify(rec.risk_flags),
  });
  return getSummary(info.lastInsertRowid);
}

function getSummary(id) {
  return rowToObject(db.prepare('SELECT * FROM summaries WHERE id = ?').get(id));
}

function listSummaries({ priority, status, q, limit = 50 } = {}) {
  const where = [];
  const params = {};
  if (priority) { where.push('priority = @priority'); params.priority = priority; }
  if (status) { where.push('status = @status'); params.status = status; }
  if (q) { where.push('(patient_ref LIKE @q OR summary LIKE @q OR note_text LIKE @q)'); params.q = `%${q}%`; }
  params.limit = Math.min(Number(limit) || 50, 500);
  const sql = `SELECT * FROM summaries ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY id DESC LIMIT @limit`;
  return db.prepare(sql).all(params).map(rowToObject);
}

function updateStatus(id, status) {
  return db.prepare('UPDATE summaries SET status = ? WHERE id = ?').run(status, id).changes > 0;
}

function deleteSummary(id) {
  return db.prepare('DELETE FROM summaries WHERE id = ?').run(id).changes > 0;
}

function logEvent(event, detail = '', success = true) {
  db.prepare('INSERT INTO activity_log (event, detail, success) VALUES (?, ?, ?)')
    .run(event, String(detail).slice(0, 300), success ? 1 : 0);
}

function getStats() {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  const total = one('SELECT COUNT(*) AS n FROM summaries').n;
  const today = one("SELECT COUNT(*) AS n FROM summaries WHERE date(created_at) = date('now')").n;
  const open = one("SELECT COUNT(*) AS n FROM summaries WHERE status = 'open'").n;
  const openCritical = one("SELECT COUNT(*) AS n FROM summaries WHERE status = 'open' AND priority = 'Critical'").n;
  const avg = one('SELECT ROUND(AVG(risk_score),1) AS s, ROUND(AVG(processing_ms)) AS ms FROM summaries');

  const byPriority = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const r of all('SELECT priority, COUNT(*) AS n FROM summaries GROUP BY priority')) byPriority[r.priority] = r.n;

  const bySource = all('SELECT ai_source AS source, COUNT(*) AS n FROM summaries GROUP BY ai_source');
  const last7Days = all(`SELECT date(created_at) AS day, COUNT(*) AS n FROM summaries
                         WHERE created_at >= datetime('now','-6 days') GROUP BY day ORDER BY day`);

  // Most common risk categories across all summaries
  const categoryCounts = {};
  for (const r of all('SELECT risk_flags FROM summaries')) {
    for (const f of JSON.parse(r.risk_flags || '[]')) categoryCounts[f.category] = (categoryCounts[f.category] || 0) + 1;
  }
  const topRisks = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([category, n]) => ({ category, n }));

  const errors = one('SELECT COUNT(*) AS n FROM activity_log WHERE success = 0').n;
  const recentActivity = all('SELECT * FROM activity_log ORDER BY id DESC LIMIT 15');

  return {
    total, today, open, openCritical,
    avgRiskScore: avg.s || 0, avgProcessingMs: avg.ms || 0,
    byPriority, bySource, last7Days, topRisks, errors, recentActivity,
  };
}

module.exports = { saveSummary, getSummary, listSummaries, updateStatus, deleteSummary, logEvent, getStats };
