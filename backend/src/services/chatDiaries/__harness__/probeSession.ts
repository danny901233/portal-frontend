/**
 * Does the "what you already know" block ever actually appear?
 *
 * It is built from session state, and the session is only populated when the model chooses
 * to call save_customer_details or set_registration. If it does not bother, the block is
 * empty and the fix is inert — which would explain the scores not moving.
 */

import { getUnifiedChatResponse } from '../../unifiedChatAgent.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const GARAGE = '844385bf-199d-426f-8b1e-caaa98cdc21e';   // 🔵 Test — GH v3

async function main() {
  const convo = `probe-${Date.now()}`;
  const turns = [
    'Hi, my registration is V20ALA and I need a full service please',
    "I'm Dan, my number is 07976500282",
    'My postcode is CB23 9AZ',
  ];
  for (const t of turns) {
    const r = await getUnifiedChatResponse(GARAGE, t, convo, { phone: '07976500282' });
    console.log(`\n  customer: ${t}`);
    console.log(`  agent   : ${r.content.slice(0, 160)}`);
  }

  // Reach into the module's own view of this conversation the only way available from
  // outside: ask it once more and print what the prompt would carry.
  const mod: any = await import('../../unifiedChatAgent.js');
  const built = typeof mod.buildSystemPrompt === 'function';
  console.log(`\n  buildSystemPrompt exported: ${built}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
