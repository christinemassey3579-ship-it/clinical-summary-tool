// ============================================================
// AI GENERATION LAYER
// If an ANTHROPIC_API_KEY is set, Claude writes the summary.
// If not (or if the call fails), a rule-based summarizer is used,
// so the app ALWAYS works — even without an API key.
// ============================================================

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';

const SYSTEM_PROMPT = `You are a clinical documentation assistant that prepares shift-handoff summaries.
Rules:
- You do NOT diagnose, prescribe, or recommend specific medications or doses.
- Use only facts present in the note. Never invent vitals, history, or results.
- Write in plain, concise clinical language a nurse or doctor can scan in 20 seconds.
- Next steps are monitoring, communication or documentation actions only (e.g. "recheck vitals", "inform attending").
Return ONLY valid JSON with exactly these keys:
{
  "summary": "2-4 sentence overview of the patient's current situation",
  "key_points": ["3-6 short bullet facts from the note"],
  "next_steps": ["2-5 non-diagnostic handoff actions"]
}`;

async function generateWithClaude(noteText) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Clinical note:\n"""\n${noteText}\n"""` }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = (data.content || []).map((c) => c.text || '').join('');
  // Pull the JSON object out even if the model wraps it in ``` fences.
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return JSON');
  const parsed = JSON.parse(jsonMatch[0]);

  return {
    summary: String(parsed.summary || '').trim(),
    key_points: Array.isArray(parsed.key_points) ? parsed.key_points.map(String) : [],
    next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps.map(String) : [],
  };
}

// ---------- Rule-based fallback summarizer ----------
const IMPORTANT_HINTS = /\b(bp|hr|spo2|sats?|temp|pain|fever|history|hx|admitted|diagnos|allerg|medication|meds|plan|denies|reports|complains|c\/o|started|stopped|dose|labs?|x-ray|ct|mri|oxygen|fall|confus|breath|chest)/i;

function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

function generateRuleBased(noteText) {
  const sentences = splitSentences(noteText);
  const summary = sentences.slice(0, 2).join(' ') || noteText.slice(0, 250);

  let keyPoints = sentences.filter((s) => IMPORTANT_HINTS.test(s)).slice(0, 6);
  if (keyPoints.length < 3) keyPoints = sentences.slice(0, Math.min(5, sentences.length));

  return {
    summary: summary.length > 400 ? summary.slice(0, 397) + '...' : summary,
    key_points: keyPoints.map((s) => (s.length > 160 ? s.slice(0, 157) + '...' : s)),
    next_steps: ['Review the full note at handoff.', 'Confirm the care plan with the incoming clinician.'],
  };
}

async function generateSummary(noteText) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const result = await generateWithClaude(noteText);
      return { ...result, ai_source: 'claude', ai_error: null };
    } catch (err) {
      console.error('[AI] Claude failed, using rule-based fallback:', err.message);
      return { ...generateRuleBased(noteText), ai_source: 'rule-based (fallback)', ai_error: err.message };
    }
  }
  return { ...generateRuleBased(noteText), ai_source: 'rule-based', ai_error: null };
}

module.exports = { generateSummary, generateRuleBased };
