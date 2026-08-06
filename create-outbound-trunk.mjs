import { SipClient } from 'livekit-server-sdk';

const LIVEKIT_URL = 'wss://receptionmate-i9q7193z.livekit.cloud';
const API_KEY = 'APIA3UgvF96t8FF';
const API_SECRET = 'gYiSviAyUNx5mIfJHrwvGYX98RDzaelUQ2qkjL4ZuY5';

const sip = new SipClient(LIVEKIT_URL, API_KEY, API_SECRET);

// numbers[] = caller IDs this trunk is allowed to use.
// The actual per-call caller ID is set in CreateSIPParticipantRequest.from
// Using ReceptionMate's main number here as placeholder.
const trunk = await sip.createSipOutboundTrunk(
  'ReceptionMate Outbound',
  'receptionmate-outbound.sip.twilio.com',
  ['+443333701610'],  // ReceptionMate Branch
  {
    authUsername: 'receptionmate-livekit',
    authPassword: 'RMlk-SIP-2026!xK9',
  }
);

console.log('✅ Outbound trunk created:');
console.log('  Trunk ID:', trunk.sipTrunkId);
console.log('  Name:', trunk.name);
console.log('  Address:', trunk.address);
console.log('\nAdd this to LiveKit agent secrets:');
console.log(`  LIVEKIT_OUTBOUND_TRUNK_ID=${trunk.sipTrunkId}`);
