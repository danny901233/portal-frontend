/**
 * Cadence guard + dead-man ping checks for agent-watchdog.cjs.
 *
 * Run from the backend dir:  node scripts/test-watchdog-cadence.cjs
 *
 * Points WATCHDOG_LASTRUN_FILE at a temp file and never calls main(), so this touches neither
 * the live `.watchdog-lastrun.json` nor the database nor the real alert channels. It must stay
 * that way: a manual run that wrote live state once cost Dan a genuine false "recovered" SMS.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-cadence-'));
process.env.WATCHDOG_LASTRUN_FILE = path.join(tmp, 'lastrun.json');
// Must be unset, or requiring the module below would arm a real ping at an unknown URL.
delete process.env.HC_PING_URL;

const wd = require('../agent-watchdog.cjs');
const { runCadence, pingDeadMan, MIN_RUN_GAP_MS, FAST_RUNS_BEFORE_ALERT } = wd;

const stamp = (at, fast) => fs.writeFileSync(process.env.WATCHDOG_LASTRUN_FILE, JSON.stringify({ at, fast }));
let passed = 0;
function check(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

check('first ever run reports no gap and does not count as fast', () => {
  fs.rmSync(process.env.WATCHDOG_LASTRUN_FILE, { force: true });
  const { gap, fast } = runCadence();
  assert.equal(gap, null);
  assert.equal(fast, 0);
});

check('a run at the normal 5-minute cadence resets the fast counter', () => {
  stamp(Date.now() - 300000, 0);
  const { gap, fast } = runCadence();
  assert.ok(gap >= 299000, `gap was ${gap}`);
  assert.equal(fast, 0);
});

check('a fast relaunch increments the counter', () => {
  stamp(Date.now() - 3000, 0);
  assert.equal(runCadence().fast, 1);
});

check('consecutive fast relaunches accumulate to the alert threshold', () => {
  stamp(Date.now() - 3000, FAST_RUNS_BEFORE_ALERT - 1);
  assert.equal(runCadence().fast, FAST_RUNS_BEFORE_ALERT);
});

check('one fast run alone stays under the threshold (a manual run must not alert)', () => {
  stamp(Date.now() - 3000, 0);
  assert.ok(runCadence().fast < FAST_RUNS_BEFORE_ALERT);
});

check('a normal run clears an accumulated fast streak', () => {
  stamp(Date.now() - (MIN_RUN_GAP_MS + 5000), 99);
  assert.equal(runCadence().fast, 0);
});

check('a corrupt lastrun file is treated as a first run, not a crash', () => {
  fs.writeFileSync(process.env.WATCHDOG_LASTRUN_FILE, 'not json{');
  const { gap, fast } = runCadence();
  assert.equal(gap, null);
  assert.equal(fast, 0);
});

check('every run restamps the file so the next gap is measured start-to-start', () => {
  const before = Date.now();
  runCadence();
  const written = JSON.parse(fs.readFileSync(process.env.WATCHDOG_LASTRUN_FILE, 'utf8'));
  assert.ok(written.at >= before, 'timestamp not advanced');
});

(async () => {
  // With no URL configured the ping must be a silent no-op rather than an error or a hang —
  // that is what makes it safe to deploy this before the healthchecks check exists.
  await pingDeadMan();
  console.log('  ok  ping is a no-op when HC_PING_URL is unset');
  passed += 1;

  // A bad host must resolve, not reject: a monitoring ping may never break the watchdog.
  // HC_PING_URL is read into a const at module load, so the cache has to be dropped for a new
  // value to take effect — a plain second require() would silently re-test the no-op path above.
  process.env.HC_PING_URL = 'https://127.0.0.1:1/ping';
  delete require.cache[require.resolve('../agent-watchdog.cjs')];
  const reloaded = require('../agent-watchdog.cjs');
  const started = Date.now();
  await reloaded.pingDeadMan();
  assert.ok(Date.now() - started < 10000, 'ping did not give up promptly');
  console.log('  ok  an unreachable ping endpoint resolves instead of throwing');
  passed += 1;

  // And a run that ended badly pings the /fail path without throwing either.
  await reloaded.pingDeadMan('/fail');
  console.log('  ok  the /fail ping resolves on an unreachable endpoint too');
  passed += 1;

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
})();
