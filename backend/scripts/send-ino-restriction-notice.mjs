// Warn In'n'out that the account is about to be restricted.
//
//   node scripts/send-ino-restriction-notice.mjs --restrict-on 2026-10-15 --dry-run
//   node scripts/send-ino-restriction-notice.mjs --restrict-on 2026-10-15 --to dan@receptionmate.co.uk
//   node scripts/send-ino-restriction-notice.mjs --restrict-on 2026-10-15 --live
//
// --restrict-on is always required: the email promises a date, and a default would let someone
// send that promise without having decided on it. Our agreement says accounts unpaid after 30
// days may be restricted on 5 days' notice, so pass a date that clears both — the service warns
// on stderr when it doesn't, and only cites the agreement in the email when it does.
//
// Run from the backend directory on the box, after a build, so dist/ is current.

import 'dotenv/config';
import { sendInoRestrictionNotice } from '../dist/services/inoRestrictionNotice.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const to = value('to');
const live = flag('live');
const dryRun = flag('dry-run');
const restrictOnArg = value('restrict-on');

if (!to && !live && !dryRun) {
  console.error('Refusing to guess. Pass --dry-run, --to <address>, or --live.');
  process.exit(1);
}
if (to && live) {
  console.error('--to and --live are mutually exclusive: --live always goes to their accounts team.');
  process.exit(1);
}
if (!restrictOnArg || !/^\d{4}-\d{2}-\d{2}$/.test(restrictOnArg)) {
  console.error('Pass --restrict-on YYYY-MM-DD — the day the restriction would start.');
  process.exit(1);
}

const restrictOn = new Date(`${restrictOnArg}T00:00:00Z`);
if (Number.isNaN(restrictOn.getTime()) || restrictOn <= new Date()) {
  console.error(`--restrict-on ${restrictOnArg} is not in the future; a notice has to give notice.`);
  process.exit(1);
}

const result = await sendInoRestrictionNotice({
  restrictOn,
  // A test send goes only to the override address, with no cc, so nothing reaches the customer.
  to: to ? [to] : undefined,
  cc: to ? [] : undefined,
  dryRun,
});

console.log(JSON.stringify(result, null, 2));
console.log(
  dryRun ? '\nDry run — nothing sent.'
  : to ? `\nTEST sent to ${to}. Nothing reached the customer.`
  : `\nLIVE notice sent — restriction stated for ${result.restrictionDate}.`,
);
process.exit(result.sent || dryRun ? 0 : 1);
