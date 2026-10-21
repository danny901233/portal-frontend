/**
 * The defect scanner has one job: catch the faults I read past.
 *
 * Every fixture here is the real shape of a production call. Two of them are
 * calls a garage complained about on 21 Oct 2026 that I had read and called
 * clean — they are the reason this file exists, and if they stop failing
 * without the scanner changing, the scanner has regressed.
 *
 * Run: node scripts/test-call-defects.cjs   (from backend/)
 */
const { scanDefects } = require('./lib/call-defects.cjs');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sigs = (findings, id) => findings.filter((f) => f.callId === id).map((f) => f.signature);

// ── a baseline healthy call: a plate the caller spelled, a completed message ──
const healthy = {
  id: 'healthy1',
  garageId: 'g1',
  garageName: 'Test Garage',
  durationSeconds: 95,
  registrationNumber: 'AB12CDE',
  metrics: {
    capture: { registration_rounds: 2, registration_captured: true },
    usage: [
      { model: 'openai/gpt-4.1', provider: 'livekit', input_tokens: 900 },
      { model: 'eleven_turbo_v2_5', provider: 'ElevenLabs', audio_duration: 20, characters_count: 310 },
      { model: 'nova-3', provider: 'Deepgram', audio_duration: 40 },
    ],
    tool_call_history: [
      { tool: 'take_message', status: 'STATUS: OK', args: { reason: 'Wants a quote for a cambelt' } },
    ],
    false_booking_claim: false,
  },
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'I need a price for a cambelt please' },
    { speaker: 'agent', text: "I'll take a message and someone will call you back." },
  ],
};
check('a healthy call raises nothing', scanDefects([healthy]).length === 0,
      JSON.stringify(sigs(scanDefects([healthy]), 'healthy1')));

// ── 16056346, verbatim: rounds=0 + captured=true, and take_message never finished ──
// The plate RV66ZVH came from caller recognition, not from the caller's mouth.
// It was ANOTHER customer's vehicle. I reported the message failure and read
// straight past the plate.
const regFromRecognition = {
  id: '16056346',
  garageId: 'g1',
  garageName: 'Test Garage',
  durationSeconds: 30,
  registrationNumber: 'RV66ZVH',
  metrics: {
    capture: { registration_rounds: 0, registration_attempts: 0, registration_captured: true,
               postcode_attempts: 0, postcode_captured: true },
    usage: [
      { model: 'google/gemma-4-31b-it', provider: 'livekit' },
      { model: 'openai/gpt-4.1', provider: 'livekit' },
      { model: 'eleven_turbo_v2_5', provider: 'ElevenLabs', audio_duration: 13.06, characters_count: 240 },
      { model: 'nova-3', provider: 'Deepgram', audio_duration: 28.27 },
    ],
    tool_call_history: [
      { tool: 'take_message', status: 'STATUS: CONFIRM_NUMBER',
        args: { vehicle_registration: 'RV66ZVH', reason: 'Is the Skoda ready to collect' } },
      { tool: 'take_message', status: 'STATUS: NEED_NAME',
        args: { vehicle_registration: 'RV66ZVH', reason: 'Is the Skoda ready to collect' } },
    ],
    false_booking_claim: false,
  },
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'Is my Skoda ready to collect?' },
    { speaker: 'agent', text: 'Can I take your name?' },
  ],
};
const f1 = scanDefects([regFromRecognition]);
check('a plate captured in zero rounds is flagged', sigs(f1, '16056346').includes('reg-not-from-caller'),
      `got ${JSON.stringify(sigs(f1, '16056346'))}`);
check('a take_message that never reached OK is flagged', sigs(f1, '16056346').includes('tool-never-completed'),
      `got ${JSON.stringify(sigs(f1, '16056346'))}`);
check('the plate finding names the plate so it can be checked against the diary',
      f1.some((x) => x.signature === 'reg-not-from-caller' && String(x.detail).includes('RV66ZVH')));

// ── the ElevenLabs quota outage: the caller spoke and heard nothing back ──
const silent = {
  id: 'silent01',
  garageId: 'g2',
  garageName: 'Another Garage',
  durationSeconds: 22,
  metrics: {
    capture: {},
    usage: [
      { model: 'openai/gpt-4.1', provider: 'livekit', input_tokens: 700 },
      { model: 'nova-3', provider: 'Deepgram', audio_duration: 18 },
    ],
    provider_errors: [{ provider: 'ElevenLabs', error: 'quota_exceeded' }],
    tool_call_history: [],
  },
  transcript: [
    { speaker: 'caller', text: 'Hello? Hello, can you hear me?' },
  ],
};
check('a call with caller speech but no TTS is flagged silent',
      sigs(scanDefects([silent]), 'silent01').includes('silent-call'),
      JSON.stringify(sigs(scanDefects([silent]), 'silent01')));

// A call where nobody spoke is NOT a silent-call fault — there is no evidence
// the agent failed, and treating these as faults is what buried the real
// outage in a pile of ordinary short calls.
const nobodySpoke = { ...silent, id: 'nospeech', transcript: [], metrics: { ...silent.metrics, provider_errors: [] } };
check('a call where the caller never spoke is not called silent',
      !sigs(scanDefects([nobodySpoke]), 'nospeech').includes('silent-call'));

// ── a booking the agent claimed but never made ──
const falseClaim = {
  ...healthy, id: 'falsecl1',
  metrics: { ...healthy.metrics, false_booking_claim: true },
};
check('a claimed booking that never happened is flagged',
      sigs(scanDefects([falseClaim]), 'falsecl1').includes('false-booking-claim'));

// ── greeting itself again mid-call: the caller thinks they got cut off ──
const regreet = {
  ...healthy, id: 'regreet1',
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'I need an MOT' },
    { speaker: 'agent', text: "Thanks for calling Test Garage, how can I help today?" },
  ],
};
check('a second greeting mid-call is flagged',
      sigs(scanDefects([regreet]), 'regreet1').includes('mid-call-regreeting'),
      JSON.stringify(sigs(scanDefects([regreet]), 'regreet1')));

// ── an agent turn cut off mid-sentence ──
const truncated = {
  ...healthy, id: 'trunc001',
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'Can you do a service on Thursday?' },
    { speaker: 'agent', text: 'Let me check that for you and' },
  ],
};
check('an agent turn ending mid-sentence is flagged',
      sigs(scanDefects([truncated]), 'trunc001').includes('truncated-turn'),
      JSON.stringify(sigs(scanDefects([truncated]), 'trunc001')));

// A turn ending on a full stop is not truncated, and a question is not either.
const endsWell = {
  ...healthy, id: 'endswell',
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'Thursday please' },
    { speaker: 'agent', text: "Booked for Thursday at nine. Anything else?" },
  ],
};
check('a turn that ends properly is not called truncated',
      !sigs(scanDefects([endsWell]), 'endswell').includes('truncated-turn'));

// ── negative feedback is a finding in its own right, whatever the metrics say ──
const withFeedback = scanDefects([healthy], {
  feedback: [{ callId: 'healthy1', rating: 'down', reasons: ['agent_no_resolution'], notes: null }],
});
check('a thumbs-down is flagged even on a call that otherwise looks clean',
      sigs(withFeedback, 'healthy1').includes('negative-feedback'),
      JSON.stringify(sigs(withFeedback, 'healthy1')));
check('the feedback finding carries the reason the garage gave',
      withFeedback.some((x) => x.signature === 'negative-feedback' && String(x.detail).includes('agent_no_resolution')));
check('a thumbs-up is not a finding',
      scanDefects([healthy], { feedback: [{ callId: 'healthy1', rating: 'up', reasons: [] }] }).length === 0);

// ── a garage with no diary is never a fault (Dan, repeatedly) ──
const noDiary = {
  ...healthy, id: 'nodiary1',
  metrics: { ...healthy.metrics, diary_capabilities: { book: false }, diary: null },
};
check('a garage with no diary raises nothing on its own', scanDefects([noDiary]).length === 0,
      JSON.stringify(sigs(scanDefects([noDiary]), 'nodiary1')));

// ── shape contract: every finding must be renderable and traceable ──
const all = scanDefects([regFromRecognition, silent, falseClaim, regreet, truncated]);
check('every finding carries callId, signature, severity and a human detail',
      all.length > 0 && all.every((f) => f.callId && f.signature && f.severity && f.detail),
      JSON.stringify(all[0]));
check('severities are drawn from the documented set',
      all.every((f) => ['high', 'medium', 'low'].includes(f.severity)),
      [...new Set(all.map((f) => f.severity))].join(','));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
