// ============================================================
// SMART LOGIC LAYER
// Rule-based risk keyword detection + vital-sign checks +
// risk scoring + priority assignment + action suggestions.
//
// Why rules and not just AI? Priority must be predictable and
// explainable. The AI writes the summary; these rules decide how
// urgent the handoff is, so the same note always gets the same
// priority, and every point of the score can be traced to a reason.
// ============================================================

// Each rule: keywords to look for, how many risk points they add,
// a category label, and the handoff action to suggest.
const RISK_RULES = [
  // ---------- CRITICAL (any one of these = Critical priority) ----------
  { level: 'critical', weight: 40, category: 'Cardiac',
    keywords: ['chest pain', 'chest tightness', 'cardiac arrest', 'palpitations with syncope'],
    action: 'Escalate to the responsible clinician immediately for chest pain / cardiac symptoms.' },
  { level: 'critical', weight: 40, category: 'Respiratory',
    keywords: ['shortness of breath', 'difficulty breathing', 'respiratory distress', 'cannot breathe', 'struggling to breathe'],
    action: 'Escalate breathing difficulty now; keep patient under close observation.' },
  { level: 'critical', weight: 40, category: 'Neurological',
    keywords: ['stroke', 'slurred speech', 'facial droop', 'seizure', 'unresponsive', 'loss of consciousness'],
    action: 'Escalate neurological change immediately; note time of onset.' },
  { level: 'critical', weight: 40, category: 'Mental health safety',
    keywords: ['suicidal', 'self-harm', 'self harm', 'overdose'],
    action: 'Follow the safety protocol: do not leave patient alone, notify the clinician now.' },
  { level: 'critical', weight: 40, category: 'Bleeding / shock',
    keywords: ['severe bleeding', 'hemorrhage', 'haemorrhage', 'vomiting blood', 'sepsis', 'septic', 'anaphylaxis'],
    action: 'Escalate immediately for possible bleeding, shock or severe reaction.' },

  // ---------- HIGH ----------
  { level: 'high', weight: 20, category: 'Infection signs',
    keywords: ['fever', 'febrile', 'rigors', 'chills'],
    action: 'Recheck temperature and flag fever trend to the next clinician.' },
  { level: 'high', weight: 20, category: 'Circulation',
    keywords: ['hypotension', 'low blood pressure', 'tachycardia', 'irregular heartbeat'],
    action: 'Repeat vitals within the hour and report any further change.' },
  { level: 'high', weight: 20, category: 'Mental status',
    keywords: ['confusion', 'confused', 'altered mental status', 'disoriented', 'agitated'],
    action: 'Monitor orientation and alertness; report any decline.' },
  { level: 'high', weight: 20, category: 'Safety',
    keywords: ['fall', 'fell', 'fall risk'],
    action: 'Apply fall precautions and document any injury check.' },
  { level: 'high', weight: 20, category: 'Oxygenation',
    keywords: ['low oxygen', 'desaturation', 'hypoxia', 'on oxygen'],
    action: 'Monitor oxygen saturation closely and record readings.' },
  { level: 'high', weight: 20, category: 'Reaction',
    keywords: ['allergic reaction', 'hives', 'swelling of the face', 'severe pain'],
    action: 'Flag reaction / severe pain to the clinician for review.' },

  // ---------- MODERATE ----------
  { level: 'moderate', weight: 8, category: 'Symptoms',
    keywords: ['pain', 'nausea', 'vomiting', 'dizziness', 'dizzy', 'headache', 'cough', 'rash', 'swelling', 'fatigue', 'weakness'],
    action: 'Continue symptom monitoring and record changes at handoff.' },
  { level: 'moderate', weight: 8, category: 'Medication',
    keywords: ['missed dose', 'non-compliant', 'noncompliant', 'stopped taking', 'medication error'],
    action: 'Review medication adherence with the care team / pharmacist.' },
  { level: 'moderate', weight: 8, category: 'Intake',
    keywords: ['poor intake', 'not eating', 'dehydrated', 'dehydration', 'low urine output'],
    action: 'Track fluid and food intake/output for the next shift.' },
];

// Words that cancel a keyword when they appear just before it,
// e.g. "denies chest pain" or "no fever" should NOT raise risk.
const NEGATIONS = ['no', 'denies', 'denied', 'without', 'negative for', 'not', 'absent', 'resolved'];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True if the keyword is found AND not negated in the 5 words before it.
function findKeyword(text, keyword) {
  const re = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'gi');
  let match;
  while ((match = re.exec(text)) !== null) {
    // Only look back within the same sentence/clause.
    const before = text.slice(Math.max(0, match.index - 60), match.index).toLowerCase();
    const clause = before.split(/[.;!?\n]|\bbut\b/).pop();
    const lastWords = clause.split(/[^a-z-]+/).filter(Boolean).slice(-5).join(' ');
    const negated = NEGATIONS.some((n) => new RegExp(`\\b${n}\\b`).test(lastWords));
    if (!negated) return true;
  }
  return false;
}

// Pull basic vital signs out of free text and check them against thresholds.
function checkVitals(text) {
  const flags = [];
  const t = text.toLowerCase();

  const spo2 = t.match(/\b(?:spo2|sp02|o2 sat(?:uration)?|oxygen sat(?:uration)?|sats?)\s*(?:of|:|=|is|was)?\s*(\d{2,3})\s*%?/);
  if (spo2) {
    const v = Number(spo2[1]);
    if (v < 90) flags.push({ label: `SpO2 ${v}% (below 90%)`, weight: 35, level: 'critical', action: 'Oxygen saturation below 90% — escalate immediately.' });
    else if (v < 94) flags.push({ label: `SpO2 ${v}% (below 94%)`, weight: 20, level: 'high', action: 'Oxygen saturation below 94% — recheck and report.' });
  }

  const hr = t.match(/\b(?:hr|heart rate|pulse)\s*(?:of|:|=|is|was)?\s*(\d{2,3})/);
  if (hr) {
    const v = Number(hr[1]);
    if (v > 130 || v < 40) flags.push({ label: `Heart rate ${v} bpm`, weight: 30, level: 'critical', action: 'Heart rate far outside normal range — escalate now.' });
    else if (v > 110 || v < 50) flags.push({ label: `Heart rate ${v} bpm`, weight: 15, level: 'high', action: 'Heart rate outside normal range — repeat vitals.' });
  }

  const bp = t.match(/\b(?:bp|blood pressure)\s*(?:of|:|=|is|was)?\s*(\d{2,3})\s*\/\s*(\d{2,3})/);
  if (bp) {
    const sys = Number(bp[1]);
    if (sys < 90) flags.push({ label: `BP ${bp[1]}/${bp[2]} (low)`, weight: 30, level: 'critical', action: 'Low blood pressure — escalate to the clinician.' });
    else if (sys >= 180) flags.push({ label: `BP ${bp[1]}/${bp[2]} (very high)`, weight: 25, level: 'high', action: 'Very high blood pressure — recheck and report.' });
  }

  const temp = t.match(/\b(?:temp(?:erature)?)\s*(?:of|:|=|is|was)?\s*(\d{2,3}(?:\.\d)?)\s*(°?\s*[cf]\b)?/);
  if (temp) {
    let v = Number(temp[1]);
    const unit = (temp[2] || '').replace(/[^cf]/g, '');
    const celsius = unit === 'f' || v > 50 ? (v - 32) * 5 / 9 : v;
    if (celsius >= 39.5) flags.push({ label: `Temperature ${temp[1]}${unit ? unit.toUpperCase() : ''} (high fever)`, weight: 20, level: 'high', action: 'High temperature — recheck and flag to the clinician.' });
    else if (celsius >= 38) flags.push({ label: `Temperature ${temp[1]}${unit ? unit.toUpperCase() : ''} (fever)`, weight: 10, level: 'moderate', action: 'Temperature raised — recheck at the next round.' });
    else if (celsius > 30 && celsius < 35) flags.push({ label: `Temperature ${temp[1]}${unit ? unit.toUpperCase() : ''} (low)`, weight: 20, level: 'high', action: 'Low temperature — recheck and report.' });
  }

  return flags;
}

// Main entry point for the Smart Logic Layer.
function analyzeRisk(noteText) {
  const text = String(noteText || '');
  const detected = []; // { keyword, category, level, weight }
  const actions = new Set();
  let score = 0;
  let hasCritical = false;

  for (const rule of RISK_RULES) {
    const hits = rule.keywords.filter((k) => findKeyword(text, k));
    if (hits.length) {
      // A rule counts once even if several of its words appear (avoids double counting).
      score += rule.weight;
      actions.add(rule.action);
      if (rule.level === 'critical') hasCritical = true;
      detected.push({ category: rule.category, level: rule.level, keywords: hits, weight: rule.weight });
    }
  }

  for (const v of checkVitals(text)) {
    score += v.weight;
    actions.add(v.action);
    if (v.level === 'critical') hasCritical = true;
    detected.push({ category: 'Vital signs', level: v.level, keywords: [v.label], weight: v.weight });
  }

  score = Math.min(100, score);

  let priority;
  if (hasCritical || score >= 70) priority = 'Critical';
  else if (score >= 40) priority = 'High';
  else if (score >= 15) priority = 'Medium';
  else priority = 'Low';

  // Priority-based handoff action (always added, so every summary has a clear next step).
  const priorityActions = {
    Critical: 'Verbal handoff required — do not rely on written notes alone.',
    High: 'Review this patient first at the start of the next shift.',
    Medium: 'Include in the routine handoff and reassess within the shift.',
    Low: 'Routine handoff; continue the current care plan.',
  };

  return {
    risk_score: score,
    priority,
    risk_flags: detected,
    suggested_actions: [priorityActions[priority], ...actions],
    reasoning: detected.length
      ? `Score built from: ${detected.map((d) => `${d.category} (+${d.weight})`).join(', ')}.`
      : 'No risk keywords or abnormal vitals detected.',
  };
}

module.exports = { analyzeRisk, checkVitals, findKeyword, RISK_RULES };
