// Move Moto Oil Auto Centre Poole onto the unified agent with the Bookar diary, and put them
// through the onboarding flow they pre-date.
//
//   node scripts/onboard-motooil-bookar.cjs           # dry run — shows every step, sends nothing
//   node scripts/onboard-motooil-bookar.cjs --apply
//
// Steps, in order:
//   1. integrationProvider -> 'bookar' (they are already on agentScript 'unified-agent', but with
//      provider 'none' the agent books nothing), synced to DynamoDB.
//   2. onboardingStage -> 'awaiting_credentials' + mirror to their HighLevel opportunity.
//      setOnboardingStage refuses to move a garage that is already 'live' — deliberately, so the
//      pre-existing estate is never dragged into the pipeline — and Moto Oil is exactly that
//      case. They signed up before the flow existed, so we move them back in by hand, once.
//   3. Connect request to Bookar (+ cc us).
//   4. "Getting ready" email to the garage: add a service called "Other".
//
// Step 5 needs no action here: when Bookar submit the form, /api/diary-connect/submit connects
// the diary and calls announceGoLiveIfReady, which now recognises Bookar credentials and sends
// the go-live email with their login details.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const GARAGE_ID = 'ca363d76-626e-4532-8261-741687cb7e15';
const step = (n, s) => console.log(`\n${APPLY ? '' : '[dry] '}${n}. ${s}`);

async function main() {
  const garage = await prisma.garage.findUnique({
    where: { id: GARAGE_ID },
    select: {
      id: true, name: true, businessId: true, onboardingStage: true, ghlOpportunityId: true,
      subscriptionCostGbp: true, twilioNumber: true, welcomeEmailSentAt: true,
      agentConfiguration: { select: { agentScript: true, integrationProvider: true } },
    },
  });
  if (!garage) throw new Error('garage not found');
  console.log(`${garage.name}`);
  console.log(`  business        ${garage.businessId}`);
  console.log(`  agentScript     ${garage.agentConfiguration?.agentScript}`);
  console.log(`  provider        ${garage.agentConfiguration?.integrationProvider}`);
  console.log(`  stage           ${garage.onboardingStage}`);
  console.log(`  HL opportunity  ${garage.ghlOpportunityId || '(none)'}`);
  console.log(`  twilio          ${garage.twilioNumber || '(none)'}`);
  console.log(`  welcome sent    ${garage.welcomeEmailSentAt || 'never'}`);

  const { sendAgentConfigWebhook } = await import('../dist/routes/config.js');
  const { sendDiaryConnectRequest, sendDiaryGettingReady } = await import('../dist/services/diaryConnect.js');
  const hl = await import('../dist/services/highlevel.js');

  step(1, "integrationProvider -> 'bookar' (+ push to the agent)");
  if (APPLY) {
    await prisma.agentConfiguration.update({
      where: { garageId: GARAGE_ID },
      data: { integrationProvider: 'bookar', agentScript: 'unified-agent' },
    });
    await sendAgentConfigWebhook(GARAGE_ID);
    console.log('   done');
  }

  step(2, "onboardingStage 'live' -> 'awaiting_credentials' + HighLevel");
  if (APPLY) {
    const at = {};
    at['awaiting_credentials'] = new Date().toISOString();
    await prisma.garage.update({
      where: { id: GARAGE_ID },
      data: { onboardingStage: 'awaiting_credentials', onboardingStageAt: at },
    });
    console.log('   portal stage set');
    if (garage.ghlOpportunityId) {
      const ok = await hl.updateOpportunity(garage.ghlOpportunityId, {
        stageId: hl.HL_AWAITING_CREDENTIALS_STAGE_ID,
        monetaryValueGbp: garage.subscriptionCostGbp ?? undefined,
      });
      console.log(`   HL opportunity ${garage.ghlOpportunityId} -> Awaiting Integration Credentials (${ok ? 'ok' : 'FAILED'})`);
    } else {
      console.log('   no HL opportunity linked — nothing to move');
    }
  }

  step(3, `connect request to Bookar (${process.env.BOOKAR_CONNECT_EMAIL_TO}, cc ${process.env.BOOKAR_CONNECT_EMAIL_CC})`);
  if (APPLY) console.log('   sent:', await sendDiaryConnectRequest(garage.businessId));

  step(4, '"getting ready" email to the garage (add a service called "Other")');
  if (APPLY) console.log('   sent:', await sendDiaryGettingReady(GARAGE_ID));

  console.log(APPLY
    ? '\nDone. When Bookar submit the form the diary connects, a test booking is placed, and the go-live email with login details goes out automatically.'
    : '\nDry run — nothing written, nothing sent. Re-run with --apply.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
