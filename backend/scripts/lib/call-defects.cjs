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

// Words that carry no meaning for deciding whether two questions are the same
// one. Question words and politeness vary freely while the request underneath
// stays identical ("Could I take your name, please?" / "Can I take your name?").
const FILLER = new Set([
  'what', 'which', 'when', 'where', 'how', 'who', 'why', 'can', 'could', 'would', 'will',
  'shall', 'should', 'may', 'might', 'do', 'does', 'did', 'is', 'are', 'was', 'were', 'be',
  'been', 'am', 'have', 'has', 'had', 'i', 'you', 'your', 'yours', 'we', 'us', 'our', 'me',
  'my', 'it', 'its', 'the', 'a', 'an', 'and', 'or', 'but', 'so', 'to', 'of', 'for', 'in',
  'on', 'at', 'with', 'that', 'this', 'there', 'then', 'just', 'please', 'sorry', 'ok',
  'okay', 'right', 'um', 'uh', 'er', 'well', 'still', 'again', 'any', 'some', 'like',
  'get', 'got', 'put', 'tell', 'say', 'said', 'know', 'if', 'about',
]);

function contentWords(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && w.length > 1 && !FILLER.has(w)),
  );
}

// A registration in the text means this is the capture loop reading a plate
// back, which the capture counters already measure. Flagging it here would
// report the same struggle twice.
const PLATE_RE = /\b[A-Z]{2}\s?\d{2}\s?[A-Z]{3}\b|\b[A-Z]\d{1,3}\s?[A-Z]{3}\b/i;

/** The question sentences in a turn, so a long preamble cannot hide the repeat. */
function questionsIn(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.endsWith('?') && !PLATE_RE.test(part));
}

/**
 * Two utterances that are the same request in different words.
 *
 * Compared on content words only, against the SMALLER set, so "Which day would
 * suit you best for the MOT?" matches "What day would suit you for the MOT?".
 * Both need at least two content words: a one-word question like "how can I
 * help?" is a greeting and would otherwise match every other short question.
 */
function sameRequest(a, b) {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (wa.size < 2 || wb.size < 2) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size) >= 0.7;
}

/** Groups of utterances that are the same request, largest group first. */
function repeatedGroups(texts, minSize) {
  const groups = [];
  for (const t of texts) {
    const hit = groups.find((g) => sameRequest(g[0], t));
    if (hit) hit.push(t);
    else groups.push([t]);
  }
  return groups.filter((g) => g.length >= minSize).sort((x, y) => y.length - x.length);
}

// A caller who cannot hear the agent says one of these, and keeps saying it.
// A single "hello?" is just how people answer a phone, so the signature is the
// REPETITION while the agent is talking back.
const CANT_HEAR_RE = [
  /^\s*hello\s*[?.!]*\s*$/i,
  /\banybody there\b/i,
  /\banyone there\b/i,
  /\bcan you hear me\b/i,
  /\bare you there\b/i,
  /\bis anyone there\b/i,
];

function cantHearTurns(turns) {
  return turns.filter((t) => isCaller(t) && CANT_HEAR_RE.some((re) => re.test(textOf(t))));
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

  // 1b. The agent IS talking and the caller cannot hear a word of it. TTS ran,
  //     so the silent-call check above is blind to this: it is one-way audio,
  //     not no audio. Call 34580340 — the caller said "Hello?" four times while
  //     the agent introduced itself, and the garage marked the call down.
  const agentSpoke = turns.some((t) => isAgent(t) && textOf(t));
  const deaf = cantHearTurns(turns);
  if (agentSpoke && ttsRan(m.usage) && deaf.length >= 2) {
    add('one-way-audio', SEVERITY.high,
        `The agent was speaking and the caller could not hear it — they asked `
        + `${deaf.length}x: "${deaf.map((t) => textOf(t)).slice(0, 3).join('" / "')}". `
        + `Audio reached our side only.`);
  }

  // 1c. The agent asking the same thing twice. The caller already answered, or
  //     was never heard — either way they are being made to do it again, and it
  //     is the shape of call 21440820, which the garage marked down.
  const askedGroups = repeatedGroups(
    turns.filter(isAgent).flatMap((t) => questionsIn(textOf(t))), 2,
  );
  if (askedGroups.length) {
    const worst = askedGroups[0];
    add('agent-repeating', worst.length >= 3 ? SEVERITY.high : SEVERITY.medium,
        `The agent asked the same thing ${worst.length} times: "${worst[0].slice(0, 120)}"`);
  }

  // 1d. The caller having to say the same thing over and over. Three times is
  //     the threshold: twice happens in ordinary conversation.
  if (!(agentSpoke && ttsRan(m.usage) && deaf.length >= 2)) {
    const saidAgain = repeatedGroups(turns.filter(isCaller).map(textOf).filter(Boolean), 3);
    if (saidAgain.length) {
      const worst = saidAgain[0];
      add('caller-repeating', SEVERITY.medium,
          `The caller said the same thing ${worst.length} times and was not acted on: `
          + `"${worst[0].slice(0, 120)}"`);
    }
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
