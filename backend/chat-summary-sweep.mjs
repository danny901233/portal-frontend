/**
 * Email the garage a summary of every chat conversation, once it has gone quiet.
 *
 * The voice side has sent one email per call from the start. Chat sent one only when the agent
 * booked something or handed the conversation to a human, so an ordinary enquiry — a price
 * question, a "do you do air con", a lead that drifted off — reached nobody unless somebody went
 * looking in the portal. Ecotest's clutch enquiry on 19 Oct 2026 was exactly that.
 *
 * A chat never hangs up, so the end of one is inferred from silence. This runs on pm2 cron every
 * ten minutes and summarises anything quiet for CHAT_SUMMARY_IDLE_MINUTES (default 20).
 *
 * `.mjs` so it can import the compiled dist modules; run from the backend dir so dotenv and
 * @prisma/client resolve. Exits after each run.
 *
 *   node chat-summary-sweep.mjs                  one sweep
 *   node chat-summary-sweep.mjs --dry-run        list what it would send, send nothing
 *   node chat-summary-sweep.mjs --no-ai          plain summaries, no model call
 *   node chat-summary-sweep.mjs --limit=200      widen the batch
 *   node chat-summary-sweep.mjs --garage=<id>    one garage only (use a test garage to verify)
 *
 * CHAT_SUMMARY_START_AT (ISO date, in .env) is the rollout guard: nothing whose last message
 * predates it is ever summarised, so the first run cannot email the back catalogue.
 */
import 'dotenv/config';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const startAtRaw = process.env.CHAT_SUMMARY_START_AT;
const startAt = startAtRaw ? new Date(startAtRaw) : null;
if (!startAt || Number.isNaN(startAt.getTime())) {
  console.error('[CHAT_SUMMARY] CHAT_SUMMARY_START_AT is not set to a valid ISO date — refusing '
    + 'to run, because without it the first sweep would email a day of history at once.');
  process.exit(1);
}

const { sendDueChatSummaries } = await import('./dist/services/chatSummaryDigest.js');

if (flag('dry-run')) {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const idle = Number(process.env.CHAT_SUMMARY_IDLE_MINUTES || 20);
  const onlyGarageDry = value('garage', '');
  const due = await prisma.chatConversation.findMany({
    where: {
      summaryEmailSentAt: null,
      ...(onlyGarageDry ? { garageId: onlyGarageDry } : {}),
      lastMessageAt: {
        lte: new Date(Date.now() - idle * 60_000),
        gte: new Date(Math.max(startAt.getTime(), Date.now() - 24 * 3_600_000)),
      },
    },
    orderBy: { lastMessageAt: 'asc' },
    take: Number(value('limit', 50)),
    select: {
      id: true, platform: true, customerName: true, confirmedBooking: true,
      needsAttention: true, lastMessageAt: true, garage: { select: { name: true } },
    },
  });
  console.log(`[CHAT_SUMMARY] dry run — ${due.length} conversation(s) would be summarised:`);
  for (const c of due) {
    console.log(`  ${c.lastMessageAt.toISOString()} ${c.garage?.name} ${c.platform} `
      + `${c.customerName || '(no name)'} booked=${c.confirmedBooking} flagged=${c.needsAttention} ${c.id}`);
  }
  await prisma.$disconnect();
  process.exit(0);
}

const onlyGarage = value('garage', '');
const result = await sendDueChatSummaries({
  startAt,
  limit: Number(value('limit', 50)),
  useAi: !flag('no-ai'),
  ...(onlyGarage ? { garageIds: [onlyGarage] } : {}),
});
console.log(`[CHAT_SUMMARY] considered=${result.considered} sent=${result.sent} `
  + `skipped=${result.skipped} failed=${result.failed}`);
process.exit(result.failed > 0 && result.sent === 0 ? 1 : 0);
