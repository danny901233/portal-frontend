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

// Openers the agent uses to start a call. Said again mid-call, the caller
// believes they have been cut off and started over.
const GREETING_RE = /\b(you'?re through to|thanks for calling|welcome to|you'?ve reached)\b/i;

// A turn ending on one of these was cut off, not finished. Checking only for a
// missing full stop flags every normal trailing-off reply, which is noise.
const DANGLING_RE = /\b(and|but|or|to|the|a|an|of|for|with|your|our|we|i|is|are|was|that|so|if|on|at|in|it|you|can|will|would|just|about)$/i;

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
  if (capture.registration_captured === true && Number(capture.registration_rounds) === 0 && plate) {
    add('reg-not-from-caller', SEVERITY.high,
        `Plate ${plate} was never spoken by the caller — it came from caller recognition `
        + `(0 rounds of asking). Check it is actually their vehicle.`);
  }

  // 3. A tool that gathered everything and recorded nothing.
  const history = Array.isArray(m.tool_call_history) ? m.tool_call_history : [];
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

  // 6. An agent turn that stops mid-sentence.
  const lastAgent = agentTurns.length ? textOf(agentTurns[agentTurns.length - 1]) : '';
  if (lastAgent && !/[.!?…"')\]]$/.test(lastAgent) && DANGLING_RE.test(lastAgent)) {
    add('truncated-turn', SEVERITY.low,
        `The agent's last words stop mid-sentence: "${lastAgent.slice(-80)}"`);
  }

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
