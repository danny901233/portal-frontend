/**
 * Defect signatures across a batch of calls.
 *
 * This exists because reading calls one at a time, off their summaries and tool
 * statuses, misses whole classes of fault. Every signature below is a fault a
 * garage reported on a call that looked clean in the summary view:
 *
 *   - the ElevenLabs quota outage (21 Oct): calls connected, the LLM replied,
 *     the caller heard nothing. Indistinguishable from an ordinary short call
 *     unless you ask whether any audio was produced.
 *   - a plate supplied by caller recognition and never said by the caller. The
 *     fields all read as success: captured true, a valid plate, no errors. It
 *     was a different customer's vehicle.
 *
 * Pure: takes rows, returns findings. No database, no clock, no environment —
 * so it can be tested against real call shapes and run anywhere.
 */

// Severity drives ordering on the page, not alerting. Nothing here pages anyone:
// these are quality faults, and the watchdog owns outages.
const SEVERITY = { high: 'high', medium: 'medium', low: 'low' };

// Tools that are worthless unless they finish. A take_message that stops at
// NEED_NAME gathered the caller's problem and recorded none of it.
const MUST_COMPLETE = ['take_message', 'confirm_booking'];

// Openers the agent uses to START a call. Said again mid-call, the caller
// believes they have been cut off and put back to the beginning.
// "Thanks for calling" is deliberately NOT here: it is how the agent says
// goodbye, and including it flagged 29 of 218 calls, nearly all sign-offs.
const GREETING_RE = /\b(you'?re through to|you'?ve reached)\b/i;

function turnsOf(call) {
  const t = call && call.transcript;
  if (Array.isArray(t)) return t;
  if (t && Array.isArray(t.turns)) return t.turns;
  return [];
}

function isAgent(turn) {
  const who = String((turn && (turn.speaker || turn.role || turn.type)) || '').toLowerCase();
  return who.includes('agent') || who.includes('assistant') || who === 'ai';
}

function isCaller(turn) {
  const who = String((turn && (turn.speaker || turn.role || turn.type)) || '').toLowerCase();
  return who.includes('caller') || who.includes('user') || who.includes('customer') || who === 'human';
}

function textOf(turn) {
  return String((turn && turn.text) || '').trim();
}

/** Did any audio get produced for this caller? TTS usage is the only honest proof. */
function ttsRan(usage) {
  return (usage || []).some((u) => {
    const provider = String((u && u.provider) || '');
    const model = String((u && u.model) || '');
    return /elevenlabs|cartesia|rime|openai-tts/i.test(provider)
      || /^eleven|^sonic|^tts/i.test(model)
      || Number((u && u.characters_count) || 0) > 0;
  });
}

/**
 * Did this plate actually get written into a message or a booking? A plate that
 * recognition supplied and the agent never acted on carries no risk — and
 * recognition supplying plates is the feature working, on roughly a fifth of
 * calls. The harm only exists once an unverified plate is recorded against a job.
 */
function plateWasUsed(history, plate) {
  const want = plate.replace(/\s+/g, '').toUpperCase();
  return (history || []).some((h) => {
    const args = (h && h.args) || {};
    return Object.keys(args).some((k) => /registration|vrn|plate/i.test(k)
      && String(args[k] || '').replace(/\s+/g, '').toUpperCase() === want);
  });
}

/** "STATUS: NEED_NAME" -> "NEED_NAME"; absent -> "". */
function statusOf(entry) {
  return String((entry && entry.status) || '').replace(/^\s*STATUS:\s*/i, '').trim().toUpperCase();
}

function scanOne(call, feedbackFor) {
  const found = [];
  const m = (call && call.metrics) || {};
  const capture = m.capture || {};
  const turns = turnsOf(call);
  const add = (signature, severity, detail) => found.push({
    callId: call.id, garageId: call.garageId || null, garageName: call.garageName || null,
    createdAt: call.createdAt || null, signature, severity, detail,
  });

  // 1. The caller spoke and nothing was ever said back. Only a call where
  //    someone actually talked is evidence of a fault — a call nobody spoke on
  //    is an ordinary wrong number, and treating those as faults is what let
  //    the real outage hide among them.
  const spoke = turns.some((t) => isCaller(t) && textOf(t));
  if (spoke && !ttsRan(m.usage)) {
    const errs = (m.provider_errors || []).map((e) => String((e && (e.error || e.message)) || e)).filter(Boolean);
    add('silent-call', SEVERITY.high,
        `Caller spoke but no speech was ever generated — they heard silence.`
        + (errs.length ? ` Provider errors: ${[...new Set(errs)].slice(0, 3).join('; ')}` : ''));
  }

  // 2. A plate that arrived without the caller ever saying it. registration_rounds
  //    counts the rounds of asking; zero rounds with a captured plate means caller
  //    recognition supplied it. When recognition matches the wrong person, every
  //    field downstream reads as success and the job goes on the wrong vehicle.
  const plate = String(call.registrationNumber || capture.registration || '').trim();
  const history = Array.isArray(m.tool_call_history) ? m.tool_call_history : [];
  const unverified = capture.registration_captured === true
    && Number(capture.registration_rounds) === 0 && Boolean(plate);
  if (unverified && plateWasUsed(history, plate)) {
    // Medium, not high: this fires on roughly a sixth of calls because
    // recognition is usually right. It is a spot-check queue, not an alarm.
    add('reg-not-from-caller', SEVERITY.medium,
        `Plate ${plate} was never spoken by the caller — caller recognition supplied it `
        + `(0 rounds of asking) and the agent then wrote it into a message or booking. `
        + `If recognition matched the wrong person, this is someone else's vehicle.`);
  }

  // 3. A tool that gathered everything and recorded nothing.
  for (const tool of MUST_COMPLETE) {
    const calls = history.filter((h) => String((h && h.tool) || '') === tool);
    if (!calls.length) continue;
    const last = statusOf(calls[calls.length - 1]);
    if (last && !last.startsWith('OK')) {
      const reason = String(((calls[calls.length - 1].args || {}).reason) || '').trim();
      add('tool-never-completed', SEVERITY.medium,
          `${tool} was called ${calls.length}x and never completed — last status ${last}.`
          + (reason ? ` The caller wanted: ${reason}` : ''));
    }
  }

  // 4. The agent said a booking was made when it was not. The agent already
  //    works this out mid-call; nothing was reading the flag.
  if (m.false_booking_claim === true) {
    add('false-booking-claim', SEVERITY.high,
        'The agent told the caller a booking was made, and no booking exists.');
  }

  // 5. Greeting the caller a second time mid-call.
  const agentTurns = turns.filter(isAgent);
  const laterGreeting = agentTurns.slice(1).find((t) => GREETING_RE.test(textOf(t)));
  if (laterGreeting) {
    add('mid-call-regreeting', SEVERITY.medium,
        `The agent greeted the caller again mid-call: "${textOf(laterGreeting).slice(0, 120)}"`);
  }

  // There is no truncation signature here, on purpose. An agent turn that stops
  //    mid-sentence looks identical whether a bug cut the speech off or the
  //    CALLER interrupted — and interrupting is exactly what the agent's barge-in
  //    handling is built for, so stopping is correct behaviour. It fired on 34 of
  //    218 calls and nothing in the transcript tells the two apart, so it would
  //    have put normal calls on the page as faults. It needs a signal the agent
  //    does not currently emit (whether playback was cancelled by barge-in).

  // 7. The garage said it was wrong. That outranks anything the metrics say.
  for (const fb of feedbackFor) {
    if (String((fb && fb.rating) || '').toLowerCase() !== 'down') continue;
    const reasons = (fb.reasons || []).join(', ');
    add('negative-feedback', SEVERITY.high,
        `The garage marked this call down${reasons ? ` (${reasons})` : ''}`
        + `${fb.notes ? `: ${String(fb.notes).slice(0, 200)}` : ''}`);
  }

  return found;
}

/**
 * @param calls    rows with { id, garageId, garageName?, createdAt?, durationSeconds,
 *                 registrationNumber, metrics, transcript }
 * @param opts     { feedback?: CallFeedback rows }
 * @returns findings, highest severity first
 */
function scanDefects(calls, opts = {}) {
  const byCall = new Map();
  for (const fb of (opts.feedback || [])) {
    const k = String((fb && fb.callId) || '');
    if (!k) continue;
    if (!byCall.has(k)) byCall.set(k, []);
    byCall.get(k).push(fb);
  }
  const order = { high: 0, medium: 1, low: 2 };
  return (calls || [])
    .flatMap((c) => scanOne(c, byCall.get(String(c && c.id)) || []))
    .sort((a, b) => order[a.severity] - order[b.severity]);
}

module.exports = { scanDefects, SEVERITY, MUST_COMPLETE };
