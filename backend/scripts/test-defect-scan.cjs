/**
 * The scan job's own logic — which calls a run should look at.
 *
 * Run: node scripts/test-defect-scan.cjs   (from backend/)
 */
process.env.DEFECT_SCAN_NO_AUTORUN = '1';
const { callIdsToScan } = require('./call-defect-scan.cjs');

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

check('calls inside the window are scanned',
      callIdsToScan({ windowCallIds: ['a', 'b'], feedbackCallIds: [] }).sort().join(',') === 'a,b');

// A garage rates a call hours or days after it happened. Without this, feedback
// on an older call would never be picked up by a rolling window.
check('a call older than the window is scanned when it has fresh feedback',
      callIdsToScan({ windowCallIds: ['new1'], feedbackCallIds: ['old99'] }).includes('old99'));

check('a call in both lists is scanned once',
      callIdsToScan({ windowCallIds: ['x'], feedbackCallIds: ['x'] }).length === 1);

check('empty input yields nothing', callIdsToScan({}).length === 0);
check('blank ids are dropped', callIdsToScan({ windowCallIds: ['', null, 'ok'] }).join(',') === 'ok');

// ── which calls are worth paying a model to read ──
const { worthReading } = require('./call-defect-scan.cjs');

check('a real conversation is read', worthReading({
  durationSeconds: 95,
  transcript: [{ speaker: 'caller', text: 'I need an MOT' }, { speaker: 'agent', text: 'Thursday?' }],
}));

// Under 30 seconds nothing is emailed to the garage either, and there is not
// enough call to read. These are the bulk of the no-value rows.
check('a very short call is not read', !worthReading({
  durationSeconds: 12,
  transcript: [{ speaker: 'caller', text: 'oh' }],
}));

// A call the caller never spoke on has nothing to judge the agent against.
check('a call with no caller speech is not read', !worthReading({
  durationSeconds: 90,
  transcript: [{ speaker: 'agent', text: "You're through to Test Garage." }],
}));

check('a missing transcript is not read', !worthReading({ durationSeconds: 90, transcript: null }));
check('a missing duration is not read', !worthReading({
  transcript: [{ speaker: 'caller', text: 'hello I need an MOT' }],
}));

// ── the garage's own rules reach the analyst ──────────────────────────────
const { garageRuleTexts } = require('./call-defect-scan.cjs');

check('an active rule object is passed through', garageRuleTexts({
  agentConfiguration: { customRules: [{ text: 'Always start with the £20 diagnostic.', active: true }] },
}).join('') === 'Always start with the £20 diagnostic.');

// An inactive rule is not something the agent was told to say, so quoting it
// back must not excuse anything.
check('an inactive rule is left out', garageRuleTexts({
  agentConfiguration: { customRules: [{ text: 'Old pricing.', active: false }] },
}).length === 0);

// customRules is a string on some garages and a list on others.
check('a free-text blob of rules is passed through', garageRuleTexts({
  agentConfiguration: { customRules: 'Never quote for subframe work.' },
}).length === 1);

check('a garage with no config yields nothing', garageRuleTexts({}).length === 0);
check('a garage with no rules yields nothing',
      garageRuleTexts({ agentConfiguration: { customRules: [] } }).length === 0);
check('junk yields nothing, never a crash', garageRuleTexts(null).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
