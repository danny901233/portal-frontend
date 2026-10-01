// Send In'n'out their overdue-invoice reminder.
//
//   node scripts/send-ino-reminder.mjs --dry-run              # assemble, send nothing
//   node scripts/send-ino-reminder.mjs --to dan@receptionmate.co.uk   # test to us, no stamping
//   node scripts/send-ino-reminder.mjs --live                  # the real send, stamped
//
// Stamping is what stops the nightly chaser sending the same thing again tomorrow, so a --to
// test send never stamps, and only --live does. Run from the backend directory on the box, after
// a build, so dist/ is current.

import 'dotenv/config';
import { sendInoReminder } from '../dist/services/inoChase.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const to = value('to');
const live = flag('live');
const dryRun = flag('dry-run');

if (!to && !live && !dryRun) {
  console.error('Refusing to guess. Pass --dry-run, --to <address>, or --live.');
  process.exit(1);
}
if (to && live) {
  console.error('--to and --live are mutually exclusive: --live always goes to their accounts team.');
  process.exit(1);
}

const result = await sendInoReminder({
  // A test send goes only to the override address, with no cc, so nothing reaches the customer.
  to: to ? [to] : undefined,
  cc: to ? [] : undefined,
  stamp: live,
  dryRun,
  ordinal: value('ordinal') ?? 'third',
});

console.log(JSON.stringify(result, null, 2));
console.log(
  dryRun ? '\nDry run — nothing sent.'
  : to ? `\nTEST sent to ${to}. Nothing stamped, nothing reached the customer.`
  : `\nLIVE reminder sent. ${result.stamped} invoice(s) stamped.`,
);
process.exit(result.sent || dryRun ? 0 : 1);
