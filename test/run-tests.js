// Simple tests for the Smart Logic Layer. Run with: npm test
const assert = require('assert');
const { analyzeRisk } = require('../src/logic');

const cases = [
  { name: 'Chest pain + low BP is Critical',
    note: '72M complains of chest pain. BP 88/54, HR 124, SpO2 91%.', expect: 'Critical' },
  { name: 'Negated symptoms do not raise risk',
    note: 'Denies chest pain or shortness of breath. No fever. Eating well.', expect: 'Low' },
  { name: 'Fall + confusion is High',
    note: '81F found on floor after a fall. Now confused and disoriented. Poor intake.', expect: 'High' },
  { name: 'Mild symptoms are Medium',
    note: 'Day 2 cellulitis. Temp 38.2C. Mild swelling and pain 4/10.', expect: 'Medium' },
  { name: 'Stable patient is Low',
    note: 'Day 1 post-op. Mobilising independently, wound clean and dry. Plan discharge tomorrow.', expect: 'Low' },
  { name: 'Low SpO2 alone is Critical',
    note: 'Patient resting. SpO2 86% on room air.', expect: 'Critical' },
];

let passed = 0;
for (const c of cases) {
  const r = analyzeRisk(c.note);
  try {
    assert.strictEqual(r.priority, c.expect);
    console.log(`PASS  ${c.name}  (${r.priority}, score ${r.risk_score})`);
    passed++;
  } catch {
    console.log(`FAIL  ${c.name}  — expected ${c.expect}, got ${r.priority} (score ${r.risk_score})`);
  }
}
console.log(`\n${passed}/${cases.length} tests passed`);
process.exit(passed === cases.length ? 0 : 1);
