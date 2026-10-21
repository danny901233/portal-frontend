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

// ── one-way audio: the agent is talking and the caller cannot hear it ──
// Call 34580340 (VRS Midlands, thumbs-down). The agent spoke, so TTS ran and
// the silent-call check cannot see this. The caller said "Hello?" four times.
const oneWay = {
  ...healthy, id: 'oneway01',
  metrics: { ...healthy.metrics, tool_call_history: [] },
  transcript: [
    { speaker: 'caller', text: 'Hello?' },
    { speaker: 'caller', text: 'Hello?' },
    { speaker: 'caller', text: 'Hello?' },
    { speaker: 'agent', text: "Hi there, you're through to Test Garage. What can we do for you today?" },
    { speaker: 'caller', text: 'Hello?' },
    { speaker: 'caller', text: 'Anybody there?' },
  ],
};
check('a caller asking "hello?" over and over while the agent talks is flagged',
      sigs(scanDefects([oneWay]), 'oneway01').includes('one-way-audio'),
      JSON.stringify(sigs(scanDefects([oneWay]), 'oneway01')));

check('the one-way finding is high severity — the caller got nothing',
      scanDefects([oneWay]).some((f) => f.signature === 'one-way-audio' && f.severity === 'high'));

// A single "hello?" is how people answer a phone. Only a caller who keeps
// asking into silence is evidence of a fault.
const normalHello = {
  ...healthy, id: 'hello001',
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'Hello? Yes, I need an MOT please' },
    { speaker: 'agent', text: 'Of course. Thursday at nine is free.' },
  ],
};
check('answering the phone with "hello" is not a fault',
      !sigs(scanDefects([normalHello]), 'hello001').includes('one-way-audio'),
      JSON.stringify(sigs(scanDefects([normalHello]), 'hello001')));

// If the agent never spoke at all, that is silent-call, not one-way audio —
// the two must not both fire and double-report the same event.
const neverSpoke = {
  ...healthy, id: 'nevspk01',
  metrics: { ...healthy.metrics, usage: [{ model: 'nova-3', provider: 'Deepgram' }], tool_call_history: [] },
  transcript: [
    { speaker: 'caller', text: 'Hello?' },
    { speaker: 'caller', text: 'Hello? Can you hear me?' },
  ],
};
const nsf = sigs(scanDefects([neverSpoke]), 'nevspk01');
check('a call where the agent never spoke is silent-call, not one-way audio',
      nsf.includes('silent-call') && !nsf.includes('one-way-audio'), JSON.stringify(nsf));

// ── the agent asking the same thing twice ──
// Call 21440820 (VRS Midlands, thumbs-down): the caller said "an update on my
// car", the agent asked for a name, got nothing, and asked for the name again.
// Nothing caught it. Dan: "if the agent asks the same question multiple times
// it should flag".
const askedTwice = {
  ...healthy, id: 'asked001',
  metrics: { ...healthy.metrics, tool_call_history: [] },
  transcript: [
    { speaker: 'agent', text: "Hello this is Test Garage, how can I help you today?" },
    { speaker: 'caller', text: 'An update on my car.' },
    { speaker: 'agent', text: 'Of course, I can get the team to give you an update. Could I take your name, please?' },
    { speaker: 'agent', text: 'Sorry, are you still there? Could I take your name, please?' },
  ],
};
check('the agent asking the same question twice is flagged',
      sigs(scanDefects([askedTwice]), 'asked001').includes('agent-repeating'),
      JSON.stringify(sigs(scanDefects([askedTwice]), 'asked001')));
check('the repeat finding quotes the question that was repeated',
      scanDefects([askedTwice]).some((f) => f.signature === 'agent-repeating' && /name/i.test(f.detail)));

// Reworded, same question — the caller still had to answer it twice.
const rewordedTwice = {
  ...healthy, id: 'asked002',
  metrics: { ...healthy.metrics, tool_call_history: [] },
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'I need an MOT' },
    { speaker: 'agent', text: 'What day would suit you for the MOT?' },
    { speaker: 'caller', text: 'Whenever' },
    { speaker: 'agent', text: 'Which day would suit you best for the MOT?' },
  ],
};
check('a reworded repeat of the same question is still flagged',
      sigs(scanDefects([rewordedTwice]), 'asked002').includes('agent-repeating'),
      JSON.stringify(sigs(scanDefects([rewordedTwice]), 'asked002')));

// Different questions in sequence are a normal conversation.
const normalFlow = {
  ...healthy, id: 'asked003',
  metrics: { ...healthy.metrics, tool_call_history: [] },
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'I need an MOT' },
    { speaker: 'agent', text: 'What day would suit you?' },
    { speaker: 'caller', text: 'Thursday' },
    { speaker: 'agent', text: 'And can I take your surname?' },
    { speaker: 'caller', text: 'Smith' },
    { speaker: 'agent', text: 'What is the best number for you?' },
  ],
};
check('asking a sequence of different questions is not a fault',
      !sigs(scanDefects([normalFlow]), 'asked003').includes('agent-repeating'),
      JSON.stringify(sigs(scanDefects([normalFlow]), 'asked003')));

// Reading a plate back twice is the capture loop doing its job, and the
// capture counters already measure that — flagging it here double-reports it.
const plateReadback = {
  ...healthy, id: 'asked004',
  metrics: { ...healthy.metrics, tool_call_history: [] },
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'AB12 CDE' },
    { speaker: 'agent', text: 'Can I check that registration back — AB12CDE, is that right?' },
    { speaker: 'caller', text: 'No, AB12 CDF' },
    { speaker: 'agent', text: 'Can I check that registration back — AB12CDF, is that right?' },
  ],
};
check('reading a registration back twice is not an agent repeat',
      !sigs(scanDefects([plateReadback]), 'asked004').includes('agent-repeating'),
      JSON.stringify(sigs(scanDefects([plateReadback]), 'asked004')));

// A plate read back in the phonetic alphabet is still a plate read-back. Call
// 35204772 read "Delta Lima, six four, Whiskey Victor Bravo, is that right?"
// twice, and the plate pattern does not match spelled-out letters.
const phoneticReadback = {
  ...healthy, id: 'asked005',
  metrics: { ...healthy.metrics, tool_call_history: [] },
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'DL64 WVB' },
    { speaker: 'agent', text: 'Delta Lima, six four, Whiskey Victor Bravo, is that right?' },
    { speaker: 'caller', text: 'Sorry, say again?' },
    { speaker: 'agent', text: 'Delta Lima, six four, Whiskey Victor Bravo, is that right?' },
  ],
};
check('a phonetic registration read-back twice is not an agent repeat',
      !sigs(scanDefects([phoneticReadback]), 'asked005').includes('agent-repeating'),
      JSON.stringify(sigs(scanDefects([phoneticReadback]), 'asked005')));

// But a real question that merely mentions one phonetic-sounding word is not
// a read-back and must still be caught.
const oneGolf = {
  ...healthy, id: 'asked006',
  metrics: { ...healthy.metrics, tool_call_history: [] },
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'My Golf needs a service' },
    { speaker: 'agent', text: 'What day suits you for the Golf service?' },
    { speaker: 'caller', text: 'Um' },
    { speaker: 'agent', text: 'Which day would suit you for the Golf service?' },
  ],
};
check('a question that happens to mention a Golf is still checked for repeats',
      sigs(scanDefects([oneGolf]), 'asked006').includes('agent-repeating'),
      JSON.stringify(sigs(scanDefects([oneGolf]), 'asked006')));

// The silent-call detail must name the real provider error, not print an object.
const silentWithErrors = {
  ...silent, id: 'silerr01',
  metrics: {
    ...silent.metrics,
    provider_errors: [
      { exc: 'APIError', kind: 'tts_error', provider: 'ElevenLabs',
        detail: 'no audio frames were pushed for text: Good afternoon, Tom speaking' },
    ],
  },
};
const se = scanDefects([silentWithErrors]).find((f) => f.signature === 'silent-call');
check('the silent-call finding quotes the real provider error',
      Boolean(se) && /no audio frames/.test(se.detail), se ? se.detail : 'no finding');
check('the silent-call finding never prints [object Object]',
      Boolean(se) && !/\[object Object\]/.test(se.detail), se ? se.detail : 'no finding');

// ── the caller having to repeat themselves ──
const callerRepeats = {
  ...healthy, id: 'callrep1',
  metrics: { ...healthy.metrics, tool_call_history: [] },
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'I need a new exhaust' },
    { speaker: 'agent', text: 'Sorry, could you say that again?' },
    { speaker: 'caller', text: 'I need a new exhaust' },
    { speaker: 'agent', text: 'Sorry, I missed that.' },
    { speaker: 'caller', text: 'I need a new exhaust' },
  ],
};
check('a caller saying the same thing three times is flagged',
      sigs(scanDefects([callerRepeats]), 'callrep1').includes('caller-repeating'),
      JSON.stringify(sigs(scanDefects([callerRepeats]), 'callrep1')));

// One-way audio already describes the hello-hello case; do not report both.
check('the hello-hello call is not also reported as caller-repeating',
      !sigs(scanDefects([oneWay]), 'oneway01').includes('caller-repeating'),
      JSON.stringify(sigs(scanDefects([oneWay]), 'oneway01')));

// ── a booking the agent claimed but never made ──
const falseClaim = {
  ...healthy, id: 'falsecl1',
  metrics: { ...healthy.metrics, false_booking_claim: true },
};
check('a claimed booking that never happened is flagged',
      sigs(scanDefects([falseClaim]), 'falsecl1').includes('false-booking-claim'));

// (The old 'thanks for calling' re-greeting fixture lived here. Production
// showed that phrase is the agent's GOODBYE; the signOff / realRegreet pair
// below replaced it.)

// (The old 'truncated final turn' fixture lived here. Production showed a
// truncated last turn is the caller hanging up during the goodbye, so the
// pair below — cut off mid-call vs hung up on the goodbye — replaced it.)

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

// ── what the production run taught, 21 Oct: three signatures were mostly noise ──

// "Thanks for calling" is how the agent says GOODBYE. 29 of 218 calls were
// flagged as re-greetings and nearly all were sign-offs like this one.
const signOff = {
  ...healthy, id: 'signoff1',
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'Thursday please' },
    { speaker: 'agent', text: 'Thanks for calling, Susan. Goodbye!' },
  ],
};
check('a goodbye that thanks the caller is not a re-greeting',
      !sigs(scanDefects([signOff]), 'signoff1').includes('mid-call-regreeting'),
      JSON.stringify(sigs(scanDefects([signOff]), 'signoff1')));

// This one is real: the agent restarted the call at the caller.
const realRegreet = {
  ...healthy, id: 'regreet2',
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'I need an MOT' },
    { speaker: 'agent', text: "You're through to Test Garage already—how can I help today?" },
  ],
};
check('starting the call over mid-call is still flagged',
      sigs(scanDefects([realRegreet]), 'regreet2').includes('mid-call-regreeting'),
      JSON.stringify(sigs(scanDefects([realRegreet]), 'regreet2')));

// Truncation is deliberately NOT a signature. A caller interrupting produces
// the same broken agent turn as a bug cutting the speech off, and interrupting
// is what barge-in is for. Both shapes below must stay silent until the agent
// reports whether playback was cancelled.
const cutOffThenCaller = {
  ...healthy, id: 'cutoff01',
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'agent', text: 'Let me check that for you and' },
    { speaker: 'caller', text: 'Sorry, what was that?' },
    { speaker: 'agent', text: 'Thursday at nine is free.' },
  ],
};
const hungUpOnGoodbye = {
  ...healthy, id: 'hungup01',
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: 'Thursday please' },
    { speaker: 'agent', text: "You're welcome Sian, have a" },
  ],
};
check('a broken agent turn is not reported as a fault either way',
      scanDefects([cutOffThenCaller, hungUpOnGoodbye]).length === 0,
      JSON.stringify(scanDefects([cutOffThenCaller, hungUpOnGoodbye]).map((x) => x.signature)));

// "You're welcome to bring it in" is not a greeting.
const welcomeTo = {
  ...healthy, id: 'welcome1',
  transcript: [
    { speaker: 'agent', text: "You're through to Test Garage, how can I help?" },
    { speaker: 'caller', text: "It won't start" },
    { speaker: 'agent', text: "You're welcome to have it brought to us. We can book it in for Thursday." },
  ],
};
check('an ordinary sentence starting "you are welcome to" is not a re-greeting',
      !sigs(scanDefects([welcomeTo]), 'welcome1').includes('mid-call-regreeting'),
      JSON.stringify(sigs(scanDefects([welcomeTo]), 'welcome1')));

// Caller recognition supplying the plate is NORMAL — it is the feature working,
// and it fired on 41 of 218 calls. What is NOT normal is an unverified plate
// being written into a message or a booking, which is how another customer's
// vehicle ended up on a message.
const recognisedButUnused = {
  ...healthy, id: 'recog001',
  registrationNumber: 'XY11ABC',
  metrics: {
    ...healthy.metrics,
    capture: { registration_rounds: 0, registration_captured: true },
    tool_call_history: [],
  },
};
check('a recognised plate the agent never acted on is not a finding',
      !sigs(scanDefects([recognisedButUnused]), 'recog001').includes('reg-not-from-caller'),
      JSON.stringify(sigs(scanDefects([recognisedButUnused]), 'recog001')));

const recognisedAndUsed = {
  ...healthy, id: 'recog002',
  registrationNumber: 'XY11ABC',
  metrics: {
    ...healthy.metrics,
    capture: { registration_rounds: 0, registration_captured: true },
    tool_call_history: [
      { tool: 'take_message', status: 'STATUS: OK',
        args: { vehicle_registration: 'XY11ABC', reason: 'Is the car ready' } },
    ],
  },
};
check('an unverified plate written into a message is flagged',
      sigs(scanDefects([recognisedAndUsed]), 'recog002').includes('reg-not-from-caller'),
      JSON.stringify(sigs(scanDefects([recognisedAndUsed]), 'recog002')));

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
const all = scanDefects([regFromRecognition, silent, falseClaim, realRegreet]);
check('every finding carries callId, signature, severity and a human detail',
      all.length > 0 && all.every((f) => f.callId && f.signature && f.severity && f.detail),
      JSON.stringify(all[0]));
check('severities are drawn from the documented set',
      all.every((f) => ['high', 'medium', 'low'].includes(f.severity)),
      [...new Set(all.map((f) => f.severity))].join(','));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
