// Sandbox test for the Garage Hive reminder source. Run with:
//   GARAGEHIVE_TENANT_ID=... GARAGEHIVE_CLIENT_ID=... GARAGEHIVE_CLIENT_SECRET=... \
//   GARAGEHIVE_ENVIRONMENT=... GARAGEHIVE_COMPANY_ID=... \
//   npx tsx src/test-gh-reminders.ts
import { resolveCreds, getReminderContacts } from './services/garageHiveBc.js';

async function main() {
  const creds = await resolveCreds();
  if (!creds) {
    console.error('Missing GARAGEHIVE_* env vars');
    process.exit(1);
  }

  // Test vehicles were seeded due 2026-08-02; pin "now" so daysAhead=30 targets it.
  const now = new Date('2026-07-03T00:00:00Z');
  console.log(`Querying vehicles due 30 days from ${now.toISOString().slice(0, 10)} (target 2026-08-02)...\n`);

  const { contacts, skipped } = await getReminderContacts(creds, 30, now);

  console.log(`✅ ${contacts.length} reminder contact(s):`);
  for (const c of contacts) {
    const due = c.motDueDate ? `MOT ${c.motDueDate}` : `service ${c.serviceDueDate}`;
    console.log(`   ${c.registration}  ${c.customerName}  ${c.phone}  [${c.dueType}: ${due}]`);
  }
  if (skipped.length) {
    console.log(`\n⚠️  ${skipped.length} skipped:`);
    for (const s of skipped) console.log(`   ${s.reg}: ${s.reason}`);
  }
}

main().catch((e) => {
  console.error('FAILED:', e.response?.data ?? e.message);
  process.exit(1);
});
