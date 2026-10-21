/**
 * The watchdog must find its OWN .env, not the one in whatever directory pm2
 * happens to launch it from.
 *
 * On 21 Oct 2026 pm2 was running it with cwd=/home/ec2-user/portal-frontend
 * (the repo root), whose .env holds DATABASE_URL and nothing else. So the DB
 * checks ran, found a real issue at 07:00, and the alert was dropped with
 * "mailgun not configured" / "twilio not configured" — detection with no way
 * to tell anyone. The Twilio hard-down check and the DynamoDB config-sync
 * check were silently skipped for the same reason.
 *
 * Run: node scripts/test-watchdog-env.cjs   (from backend/)
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WATCHDOG = path.join(__dirname, '..', 'agent-watchdog.cjs');
const ENV_FILE = path.join(__dirname, '..', '.env');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

if (!fs.existsSync(ENV_FILE)) {
  console.log('backend/.env is absent — nothing to prove. Run this where the env file lives.');
  process.exit(0);
}

// Keys the alert channels and the env-gated checks depend on. Only the ones
// actually present locally are asserted, so this test says nothing about keys
// this machine was never given.
const envText = fs.readFileSync(ENV_FILE, 'utf8');
const WANTED = ['DATABASE_URL', 'MAILGUN_API_KEY', 'MAILGUN_DOMAIN', 'TWILIO_ACCOUNT_SID',
                'TWILIO_AUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
const present = WANTED.filter((k) => new RegExp(`^${k}=.+`, 'm').test(envText));
check('the env file defines keys worth asserting', present.length > 0,
      `none of ${WANTED.join(', ')} are set in backend/.env`);
if (!present.length) process.exit(1);

// A directory with no .env at all — exactly the pm2-launched-from-elsewhere case.
const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-env-'));

// Strip the keys from the child's inherited environment so dotenv is the ONLY
// way they can arrive. Without this the test passes on the parent shell's env.
const clean = { ...process.env, WATCHDOG_NO_AUTORUN: '1' };
for (const k of WANTED) delete clean[k];

const probe = `
  require(${JSON.stringify(WATCHDOG)});
  const seen = {};
  for (const k of ${JSON.stringify(present)}) seen[k] = Boolean(process.env[k]);
  console.log('PROBE ' + JSON.stringify({ cwd: process.cwd(), seen }));
`;
const run = spawnSync(process.execPath, ['-e', probe], {
  cwd: foreign, env: clean, encoding: 'utf8', timeout: 30000,
});

const line = (run.stdout || '').split('\n').find((l) => l.startsWith('PROBE '));
check('the script loads and exits cleanly from a foreign directory', Boolean(line),
      `exit=${run.status} stderr=${(run.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);

if (line) {
  const out = JSON.parse(line.slice(6));
  check('it really ran outside the backend directory', out.cwd === fs.realpathSync(foreign), out.cwd);
  for (const k of present) {
    check(`${k} reaches the process`, out.seen[k] === true,
          'dotenv resolved .env against the cwd, so the key never loaded');
  }
}

fs.rmSync(foreign, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
