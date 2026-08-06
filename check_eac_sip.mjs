import { SipClient } from 'livekit-server-sdk';

const LIVEKIT_URL = 'wss://receptionmate-i9q7193z.livekit.cloud';
const API_KEY = 'APIA3UgvF96t8FF';
const API_SECRET = 'gYiSviAyUNx5mIfJHrwvGYX98RDzaelUQ2qkjL4ZuY5';

const EAC_GARAGE_ID = '11061962-d82b-4930-86ec-e704c22c0d57';

const sip = new SipClient(LIVEKIT_URL, API_KEY, API_SECRET);

console.log('=== LIVEKIT SIP INBOUND TRUNKS ===\n');

const trunks = await sip.listSipInboundTrunk();
console.log(`Total inbound trunks: ${trunks.length}\n`);

// Dump EAC + a known working garage (ReceptionMate Branch) for side-by-side comparison
const RM_GARAGE_ID = 'd51dfa55-15d0-4d60-ad81-c675579d16f6';
const SPALDING_GARAGE_ID = '3ccd0060-75ec-4cf5-86d9-709fb5700f9d';

let eacTrunk = null;
for (const t of trunks) {
  let meta = {};
  try { meta = t.metadata ? JSON.parse(t.metadata) : {}; } catch {}

  if (meta.garageId === EAC_GARAGE_ID || meta.garageId === RM_GARAGE_ID || meta.garageId === SPALDING_GARAGE_ID) {
    if (meta.garageId === EAC_GARAGE_ID) eacTrunk = t;
    const label = meta.garageId === EAC_GARAGE_ID ? '>>> EAC TELFORD (BROKEN)' :
                  meta.garageId === RM_GARAGE_ID ? '>>> RECEPTIONMATE BRANCH (WORKING)' :
                  '>>> IN\'N\'OUT SPALDING (WORKING)';
    console.log(label);
    console.log(JSON.stringify(t, null, 2));
    console.log('');
  }
}

if (!eacTrunk) {
  console.log('No trunk found with EAC garageId in metadata. Listing all trunks:\n');
  for (const t of trunks) {
    let meta = {};
    try { meta = t.metadata ? JSON.parse(t.metadata) : {}; } catch {}
    console.log(`  ${t.sipTrunkId} | ${t.name} | garageId: ${meta.garageId || '?'} | numbers: ${JSON.stringify(t.numbers)}`);
  }
}

console.log('\n=== LIVEKIT SIP DISPATCH RULES ===\n');

const rules = await sip.listSipDispatchRule();
console.log(`Total dispatch rules: ${rules.length}\n`);

let eacRule = null;
for (const r of rules) {
  let meta = {};
  try { meta = r.metadata ? JSON.parse(r.metadata) : {}; } catch {}

  if (meta.garageId === EAC_GARAGE_ID || r.name?.toLowerCase().includes('eac')) {
    eacRule = r;
    console.log('>>> EAC TELFORD DISPATCH RULE FOUND <<<');
    console.log(JSON.stringify(r, null, 2));
    console.log('');
  }
}

if (!eacRule) {
  console.log('No dispatch rule found for EAC. Listing all rules:\n');
  for (const r of rules) {
    let meta = {};
    try { meta = r.metadata ? JSON.parse(r.metadata) : {}; } catch {}
    console.log(`  ${r.sipDispatchRuleId} | ${r.name} | garageId: ${meta.garageId || '?'} | trunkIds: ${JSON.stringify(r.trunkIds)}`);
  }
}

// Compare includeHeaders across all trunks
console.log('\n=== INCLUDE HEADERS COMPARISON (all trunks) ===\n');
for (const t of trunks) {
  const name = (t.name || '?').padEnd(55);
  const ih = (t.includeHeaders || 'NOT_SET').padEnd(25);
  const krisp = t.krispEnabled ? 'krisp=ON ' : 'krisp=OFF';
  const isEac = t.name?.includes('EAC') ? ' <<<< EAC' : '';
  console.log(`  ${name} | includeHeaders: ${ih} | ${krisp}${isEac}`);
}

// Also compare dispatch rules hidePhoneNumber
console.log('\n=== DISPATCH RULES: hidePhoneNumber CHECK ===\n');
for (const r of rules) {
  const name = (r.name || '?').padEnd(55);
  const hide = r.hidePhoneNumber ? 'HIDDEN' : 'visible';
  const isEac = r.name?.includes('EAC') ? ' <<<< EAC' : '';
  console.log(`  ${name} | phoneNumber: ${hide}${isEac}`);
}
