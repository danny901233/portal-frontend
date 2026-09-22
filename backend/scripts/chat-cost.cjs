#!/usr/bin/env node
/**
 * What chat actually costs us, per message and per garage.
 *
 * The number WhatsApp's move to per-message billing made urgent: Connect sells conversations,
 * Meta sells messages, and until ChatUsage existed nothing measured the gap.
 *
 *   node scripts/chat-cost.cjs [days]     # default 30
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const DAYS = Number(process.argv[2] || 30);
const USD_TO_GBP = Number(process.env.USD_TO_GBP || 0.79);
// Meta's UK rate card, per delivered message. 1,000 service messages per phone number are free
// each month from 1 October 2026.
const META_PER_MESSAGE_GBP = Number(process.env.META_PER_MESSAGE_GBP || 0.0159);

const gbp = (usd) => usd * USD_TO_GBP;

(async () => {
  const since = new Date(Date.now() - DAYS * 86400000);
  const rows = await p.chatUsage.findMany({
    where: { createdAt: { gte: since } },
    select: { garageId: true, conversationId: true, channel: true, model: true,
              inputTokens: true, cachedTokens: true, outputTokens: true, costMicroUsd: true },
  });

  if (!rows.length) {
    console.log(`No chat usage recorded in the last ${DAYS} days.`);
    console.log('Expected if this has only just been deployed — it records from now on, not retrospectively.');
    await p.$disconnect();
    return;
  }

  const totalUsd = rows.reduce((s, r) => s + r.costMicroUsd, 0) / 1e6;
  const convs = new Set(rows.map((r) => r.conversationId).filter(Boolean));

  // One assistant MESSAGE is what Meta bills; several model calls can sit behind one.
  const assistantMsgs = await p.chatMessage.count({
    where: { role: 'assistant', createdAt: { gte: since } },
  });

  console.log(`Last ${DAYS} days`);
  console.log(`  model calls          ${rows.length}`);
  console.log(`  conversations        ${convs.size}`);
  console.log(`  assistant messages   ${assistantMsgs}`);
  console.log(`  AI spend             £${gbp(totalUsd).toFixed(2)}`);
  if (assistantMsgs) {
    const aiPerMsg = gbp(totalUsd) / assistantMsgs;
    console.log(`\n  AI cost per message      £${aiPerMsg.toFixed(4)}`);
    console.log(`  Meta cost per message    £${META_PER_MESSAGE_GBP.toFixed(4)}  (after the free 1,000/number)`);
    console.log(`  ALL-IN per message       £${(aiPerMsg + META_PER_MESSAGE_GBP).toFixed(4)}`);
  }
  if (convs.size) {
    const perConv = gbp(totalUsd) / convs.size;
    const msgsPerConv = assistantMsgs / convs.size;
    console.log(`\n  messages per conversation ${msgsPerConv.toFixed(1)}`);
    console.log(`  ALL-IN per conversation   £${(perConv + msgsPerConv * META_PER_MESSAGE_GBP).toFixed(4)}`);
    console.log(`  Connect overage price     £0.2000  <- what we charge for one more conversation`);
  }

  const byModel = {};
  for (const r of rows) {
    const m = (byModel[r.model] ||= { n: 0, usd: 0, in: 0, out: 0 });
    m.n++; m.usd += r.costMicroUsd / 1e6; m.in += r.inputTokens; m.out += r.outputTokens;
  }
  console.log('\n  by model:');
  for (const [m, v] of Object.entries(byModel).sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`    ${m.padEnd(16)} ${String(v.n).padStart(6)} calls  £${gbp(v.usd).toFixed(2)}  ` +
                `${Math.round(v.in / v.n)} in / ${Math.round(v.out / v.n)} out avg`);
  }

  const byGarage = {};
  for (const r of rows) {
    if (!r.garageId) continue;
    const g = (byGarage[r.garageId] ||= { usd: 0, calls: 0 });
    g.usd += r.costMicroUsd / 1e6; g.calls++;
  }
  const names = await p.garage.findMany({
    where: { id: { in: Object.keys(byGarage) } }, select: { id: true, name: true } });
  const nm = Object.fromEntries(names.map((g) => [g.id, g.name]));
  console.log('\n  by garage:');
  for (const [id, v] of Object.entries(byGarage).sort((a, b) => b[1].usd - a[1].usd).slice(0, 15)) {
    console.log(`    £${gbp(v.usd).toFixed(2).padStart(8)}  ${String(v.calls).padStart(5)} calls  ${nm[id] || id}`);
  }
  await p.$disconnect();
})();
