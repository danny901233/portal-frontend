/**
 * Outbound Chat Simulation
 * Simulates a customer replying to an outbound WhatsApp campaign.
 * Seeds the session exactly as meta-whatsapp.ts does, then replays
 * a scripted conversation against the local backend.
 *
 * Usage:
 *   node simulate_outbound.js
 *
 * Edit MESSAGES below to test different conversation flows.
 */

const { PrismaClient } = require('/home/ec2-user/portal-frontend/backend/node_modules/.prisma/client');
const http = require('http');

const prisma = new PrismaClient();

// ── Config ─────────────────────────────────────────────────────────────────
const GARAGE_ID   = 'd51dfa55-15d0-4d60-ad81-c675579d16f6'; // receptionmatebr branch
const BACKEND_URL = 'http://localhost:4000';

// CSV / outbound data (what the campaign knows)
const OUTBOUND = {
  customerName:    'Dan Test',
  registration:    'V20ALA',
  serviceType:     'mot',       // 'mot' | 'service'
  motDueDate:      '16-Apr-26',
};

// ── Conversation to simulate ───────────────────────────────────────────────
// Edit this array to test different flows.
const MESSAGES = [
  'yeah go on then',                             // very casual yes
  'nah just the MOT cheers',                     // declining upsell casually
  'whenever is earliest tbh',                    // no date preference, wants earliest
  'actually no wait, can i do next friday?',     // changing mind mid-flow
  'afternoon if possible',                       // vague time
  'second one',                                  // picking by position from slot list
  'no wait sorry can I change to the morning',   // changing time after seeing slots
  'first one',                                   // picking morning slot
  'yep thats perfect',                           // confirming slot
  'its 07711 445566',                            // phone with text around it
  'the postcode is SW6 1AA',                     // postcode with text around it
  '22',                                          // house number
];

// ── Helpers ────────────────────────────────────────────────────────────────
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'localhost',
      port: 4000,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = http.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function separator() {
  console.log('\n' + '─'.repeat(60));
}

// ── Main ───────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n🤖  OUTBOUND SIMULATION');
  console.log(`    Garage : ${GARAGE_ID}`);
  console.log(`    Reg    : ${OUTBOUND.registration}`);
  console.log(`    Service: ${OUTBOUND.serviceType.toUpperCase()}`);
  console.log(`    Due    : ${OUTBOUND.motDueDate}`);

  // 1. Create a fresh conversation directly in the DB (mirrors what meta-whatsapp.ts does)
  separator();
  console.log('[SETUP] Creating conversation…');
  const conv = await prisma.chatConversation.create({
    data: {
      garageId: GARAGE_ID,
      platform: 'whatsapp',
      platformUserId: `sim_${Date.now()}`,
      customerName: OUTBOUND.customerName,
      status: 'active',
    },
  });
  const conversationId = conv.id;
  console.log(`[SETUP] Conversation ID: ${conversationId}`);

  // 2. Patch sessionState exactly as the outbound webhook does — BEFORE sending any messages
  const nameParts = OUTBOUND.customerName.trim().split(/\s+/);
  await prisma.$executeRawUnsafe(
    `UPDATE "ChatConversation" SET "sessionState" = COALESCE("sessionState", '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    JSON.stringify({
      customerNameFirst:   nameParts[0] || '',
      customerNameLast:    nameParts.slice(1).join(' ') || '',
      outboundRegistration: OUTBOUND.registration,
      outboundServiceType: OUTBOUND.serviceType,
      outboundDueDate:     OUTBOUND.motDueDate,
      step:                'need_service',
      vrn:                 OUTBOUND.registration,
      vrnConfirmed:        true,
      sessionId:           null,
      vehicleMake:         null,
      vehicleModel:        null,
      servicesAvailable:   null,
      serviceSelectedName: null,
      serviceSelectedId:   null,
      servicePrice:        null,
      timeslotsAvailable:  null,
      bookingDate:         null,
      bookingTime:         null,
    }),
    conversationId,
  );
  console.log('[SETUP] Session seeded with outbound context.');

  // 3. Send all messages — session is already seeded so first message gets full outbound context
  for (let i = 0; i < MESSAGES.length; i++) {
    const msg = MESSAGES[i];
    separator();
    console.log(`👤  Customer: ${msg}`);

    const resp = await post('/api/chat/widget', {
      garageId:       GARAGE_ID,
      message:        msg,
      conversationId,
    });

    const msgs = resp.messages || (resp.message ? [resp.message] : []);
    if (msgs.length === 0) {
      console.log('⚠️   (no response)');
      console.log('    Raw:', JSON.stringify(resp));
    } else {
      msgs.forEach(m => console.log(`🤖  Agent   : ${m}`));
    }

    // Small delay so logs are readable and backend isn't hammered
    await new Promise(r => setTimeout(r, 800));
  }

  separator();
  console.log('\n✅  Simulation complete.\n');
  await prisma.$disconnect();
}

run().catch(async e => {
  console.error('Fatal:', e);
  await prisma.$disconnect();
  process.exit(1);
});
