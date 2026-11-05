import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeRecordingTranscript } from './recordingTranscript.js';

// Dan, 5 Nov 2026: "on a lot of our calls the transcript is not matching what was said out loud".
// Shaped on Elite 67195486 (names and plate changed): the live speech-to-text wrote "Fair enough."
// for the caller's name and dropped her spelling of it; the recording, re-transcribed, has both.

const live = [
  { type: 'message', speaker: 'agent', text: 'Good afternoon, Elite Autocare, this is Tom speaking, how can I help?', timestamp: 0.6 },
  { type: 'message', speaker: 'customer', text: 'Can I pick up my car now?', timestamp: 4.0 },
  { type: 'message', speaker: 'agent', text: 'Just to make sure I have got it right, is it Mira?', timestamp: 25.0 },
  { type: 'message', speaker: 'agent', text: "I'm sorry, I didn't quite catch that. Could you tell me your name again?", timestamp: 31.9 },
  { type: 'message', speaker: 'customer', text: 'Fair enough.', timestamp: 37.0 },
  { type: 'tool_call', tool: 'save_caller_name', parameters: {}, result: 'STATUS: OK', success: true, timestamp: 38.0 },
  { type: 'message', speaker: 'agent', text: 'To help the team find your car, could I have the registration please?', timestamp: 61.0 },
  { type: 'message', speaker: 'customer', text: 'F g six six x t v.', timestamp: 66.0 },
];

// Deepgram batch on the recording: its clock starts ~0.6s earlier than the live one, and it put a
// short agent line on the caller's speaker id.
const utts = [
  { start: 0.0, end: 3.5, speaker: 0, transcript: 'Good afternoon. Elite Autocare. This is Tom speaking. How can I help?' },
  { start: 3.2, end: 9.0, speaker: 1, transcript: "Hey, Tom. Can I pick up my car now?" },
  { start: 24.4, end: 27.0, speaker: 1, transcript: 'Just to make sure I have got it right, is it Mira?' },
  { start: 28.9, end: 31.0, speaker: 1, transcript: 'M I R A.' },
  { start: 31.9, end: 35.5, speaker: 0, transcript: "I'm sorry. I didn't quite catch that. Could you tell me your name again?" },
  { start: 36.8, end: 37.6, speaker: 1, transcript: 'Mira.' },
  { start: 60.4, end: 64.0, speaker: 0, transcript: 'To help the team find your car, could I have the registration, please?' },
  { start: 65.9, end: 68.0, speaker: 1, transcript: 'FG66XTB.' },
];

test('the caller lines come from the recording; the agent lines and tool steps stay', () => {
  const out = mergeRecordingTranscript(live, utts);
  assert.ok(out);
  const said = out!.filter((e) => e.type === 'message').map((e) => `${e.speaker}: ${e.text}`);
  assert.deepEqual(said, [
    'agent: Good afternoon, Elite Autocare, this is Tom speaking, how can I help?',
    "customer: Hey, Tom. Can I pick up my car now?",
    'agent: Just to make sure I have got it right, is it Mira?',
    'customer: M I R A.',
    "agent: I'm sorry, I didn't quite catch that. Could you tell me your name again?",
    'customer: Mira.',
    'agent: To help the team find your car, could I have the registration please?',
    'customer: FG66XTB.',
  ]);
  assert.equal(out!.filter((e) => e.type === 'tool_call').length, 1);
  // Times are on the live clock, and the list is in order.
  const ts = out!.map((e) => e.timestamp as number);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  assert.equal(out!.find((e) => e.text === 'Mira.')!.timestamp, 37.4);
});

test('nothing after a completed transfer is the caller', () => {
  const u2 = [...utts, { start: 90, end: 95, speaker: 1, transcript: 'Hello, Elite, Sam speaking.' }];
  const out = mergeRecordingTranscript(live, u2, { transferAtSeconds: 80 });
  assert.ok(!out!.some((e) => e.text === 'Hello, Elite, Sam speaking.'));
});

test('a recording that does not line up with the call leaves the live transcript alone', () => {
  assert.equal(mergeRecordingTranscript(live, [{ start: 0, end: 2, speaker: 0, transcript: 'Something else entirely.' }]), null);
  assert.equal(mergeRecordingTranscript(live, []), null);
  assert.equal(mergeRecordingTranscript([], utts), null);
});
