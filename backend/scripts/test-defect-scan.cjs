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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
