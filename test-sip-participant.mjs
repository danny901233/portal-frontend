import { SipClient } from 'livekit-server-sdk';

const LIVEKIT_URL = 'wss://receptionmate-i9q7193z.livekit.cloud';
const API_KEY = 'APIA3UgvF96t8FF';
const API_SECRET = 'gYiSviAyUNx5mIfJHrwvGYX98RDzaelUQ2qkjL4ZuY5';

const sip = new SipClient(LIVEKIT_URL, API_KEY, API_SECRET);

console.log('Testing create_sip_participant with outbound trunk ST_PKxtRSAu5hqc...');

try {
  const result = await sip.createSipParticipant(
    'test-room-warm-transfer',
    'tel:+447976500282',
    '+443333701610',
    {
      participantIdentity: 'human-transfer-test',
      participantName: 'Team Member',
      playDialtone: true,
      sipTrunkId: 'ST_PKxtRSAu5hqc',
    }
  );
  console.log('✅ Success:', JSON.stringify(result, null, 2));
} catch (e) {
  console.error('❌ Error:', e.message);
  if (e.status) console.error('   Status:', e.status);
  if (e.code) console.error('   Code:', e.code);
}
