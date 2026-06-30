// Stage 2 of portal call diagnostics: an automatic AI "call analyst".
// Given a call's transcript + the agent's tool-call timeline, produce a short
// plain-English verdict (did it succeed, and if not, why) that staff can read on
// the call page instead of downloading and reading the LiveKit observability export.
//
// Uses OpenAI gpt-4o-mini (cheap triage on every call) — the same provider the rest
// of the backend already uses, so no new key/vendor. A heavier model can be passed
// in for the on-demand "analyse in depth" action.

import OpenAI from 'openai';

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export interface CallDiagnosis {
  status: 'ok' | 'issue';
  headline: string;
  detail: string;
  suggestedAction?: string;
  category?: string;
  model: string;
  generatedAt: string;
  // Populated by the deep-dive (auto-run when triage flags an issue, or via "Analyse in depth").
  rootCause?: string;
  fix?: string;
  severity?: 'low' | 'medium' | 'high';
  deepModel?: string;
}

// Render the agent's tool-call history into a compact, readable timeline.
function buildToolTimeline(metrics: unknown): string {
  const hist = (metrics as { tool_call_history?: unknown })?.tool_call_history;
  if (!Array.isArray(hist) || hist.length === 0) return '(no tool calls recorded)';
  return hist
    .map((t: Record<string, unknown>, i: number) => {
      const status = String(t.status ?? '').split('\n')[0];
      const err = t.error ? `  ERROR: ${String(t.error)}` : '';
      const args = t.args && Object.keys(t.args as object).length
        ? ' ' + JSON.stringify(t.args).slice(0, 200) : '';
      return `${i + 1}. ${String(t.tool)} -> ${status}${err}${args}`;
    })
    .join('\n');
}

function buildTranscript(transcript: unknown): string {
  if (!Array.isArray(transcript)) return '';
  return transcript
    // Only spoken lines — tool calls are covered separately by the TOOL TIMELINE.
    .filter((m: Record<string, unknown>) => m.type !== 'tool_call' && (m.content ?? m.text))
    .map((m: Record<string, unknown>) =>
      `${String(m.role ?? m.speaker ?? '?')}: ${String(m.content ?? m.text ?? '')}`)
    .join('\n')
    .slice(0, 8000);
}

// Does this agent line look like a registration/postcode read-back? The agent's ~5s pause BEFORE one
// is its INTENTIONAL "are you still spelling?" timer — not dead air — so those gaps are excluded from
// the real dead-air number. Reg-catching was our biggest problem; this protects it from being flagged.
function isRegReadback(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (/\b(registration|reg|postcode|post ?code)\b/.test(t) && /(right|correct|confirm)/.test(t)) return true;
  if (/(so that'?s|i'?ve got|i have it as|got that as|i have got that as)/.test(t) && /(right|correct)/.test(t)) return true;
  // a run of 3+ single-character / number-word tokens = a spelled-out reg/postcode read-back
  const tokens = t.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  let run = 0;
  let maxRun = 0;
  for (const tok of tokens) {
    if (tok.length === 1 || /^(zero|one|two|three|four|five|six|seven|eight|nine|double|triple)$/.test(tok)) {
      run++; if (run > maxRun) maxRun = run;
    } else run = 0;
  }
  return maxRun >= 3;
}

// Longest caller->agent wait, split into ALL gaps vs REAL dead air (excluding the intentional pause
// before a reg/postcode read-back). Computed from the stored transcript timestamps — works for EVERY
// call (incl. older ones the agent didn't measure). This is the deterministic dead-air exclusion.
function silenceBreakdown(transcript: unknown): { maxAll: number | null; maxOffReg: number | null } {
  if (!Array.isArray(transcript)) return { maxAll: null, maxOffReg: null };
  const msgs = transcript
    .filter((m: Record<string, unknown>) => (m.type ?? 'message') === 'message' && (m.text ?? m.content))
    .map((m: Record<string, unknown>) => {
      const who = m.speaker ?? m.role;
      const ts = typeof m.timestamp === 'number' ? m.timestamp : (typeof m.ts === 'number' ? m.ts : null);
      return { spk: who === 'agent' || who === 'assistant' ? 'agent' : 'customer', ts, text: String(m.text ?? m.content ?? '') };
    })
    .filter((m) => m.ts !== null) as { spk: string; ts: number; text: string }[];
  if (!msgs.length) return { maxAll: null, maxOffReg: null };
  let all = 0;
  let offReg = 0;
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].spk === 'agent' && msgs[i - 1].spk === 'customer') {
      const gap = msgs[i].ts - msgs[i - 1].ts;
      if (gap > all) all = gap;
      if (!isRegReadback(msgs[i].text) && gap > offReg) offReg = gap;
    }
  }
  return { maxAll: Math.round(all * 10) / 10, maxOffReg: Math.round(offReg * 10) / 10 };
}

// Render the per-call timing summary so the model can judge whether the call was slow/silent.
function buildTiming(metrics: unknown, transcript: unknown): string {
  const lat = (metrics as { latency?: Record<string, unknown> })?.latency ?? {};
  // Compute both numbers deterministically from the transcript: the longest gap overall, and the
  // longest gap that is NOT the intentional reg/postcode read-back pause. The dead-air judgement
  // MUST use the off-reg number so the ~5s read-back timer is never flagged.
  const bd = silenceBreakdown(transcript);
  return (
    `REAL DEAD AIR — longest silence EXCLUDING the agent's intentional reg/postcode read-back pause: ` +
    `${bd.maxOffReg ?? '?'}s. Flag dead air ONLY on THIS number, and only if it is over ~5s. ` +
    `(For reference only, the longest gap INCLUDING the read-back pause was ${bd.maxAll ?? '?'}s — ` +
    `this is the agent's expected ~5s reg/postcode timer, do NOT flag it.) ` +
    `AGENT RESPONSIVENESS (authoritative — measured from when the CALLER STOPPED speaking, so it ` +
    `EXCLUDES the caller's own pauses): worst reply gap ${lat.response_gap_max_s ?? '?'}s, ` +
    `p50 ${lat.response_gap_p50_s ?? '?'}s, replies over 3s: ${lat.slow_responses_over_3s ?? '?'}. ` +
    `If worst reply gap is small (under ~3s) and replies-over-3s is 0, the agent answered promptly on ` +
    `EVERY turn — so any large transcript silence above is the CALLER pausing or holding the line, ` +
    `NOT agent dead air, and you must NOT flag dead_air. ` +
    `Slowest time-to-first-word: ${lat.llm_ttft_max_s ?? '?'}s (over ${lat.turns_measured ?? '?'} turns)`
  );
}

// Render how hard the agent had to work to capture the registration / postcode.
function buildCapture(metrics: unknown): string {
  const cap = (metrics as { capture?: Record<string, unknown> })?.capture;
  if (!cap || typeof cap !== 'object') return '(not captured)';
  const parts: string[] = [];
  if ('registration_attempts' in cap) {
    parts.push(
      `registration: ${cap.registration_captured ? 'captured' : 'NOT captured'} after ` +
      `${cap.registration_attempts ?? 0} restart(s)/correction(s)`,
    );
  }
  if ('postcode_attempts' in cap) {
    parts.push(
      `postcode: ${cap.postcode_captured ? 'captured' : 'NOT captured'} after ` +
      `${cap.postcode_attempts ?? 0} restart(s)/correction(s)`,
    );
  }
  return parts.length ? parts.join('; ') : '(not captured)';
}

const SYSTEM_PROMPT =
  'You are a QA analyst for ReceptionMate, an AI phone receptionist for UK car garages. ' +
  "You are given one call's transcript, the agent's tool-call log, and timing. Decide whether the " +
  'call had a real PROBLEM.\n' +
  'Mark status "issue" ONLY when something actually went WRONG — a failure the agent or system is ' +
  'responsible for. Examples of real issues: a tool call that ERRORED (cite it); a booking that ' +
  'could not be completed because of a system failure or NO AVAILABILITY (say which); GarageHive ' +
  'rejecting the submit; a registration or postcode the agent mis-heard and did NOT correct; a ' +
  'transfer that failed to connect; the agent going SILENT / a long dead-air gap; the agent giving ' +
  'WRONG information, hallucinating, or not following its brief.\n' +
  'Mark status "ok" when the agent handled the call CORRECTLY — EVEN IF no booking was made. A call ' +
  'with no booking is NOT a problem by itself: the caller may have only wanted information, decided ' +
  'not to book, asked for a message/callback (a valid, successful outcome), or simply ended the call. ' +
  'Taking a message is a SUCCESS, not a failure. Do NOT flag these as issues. When in doubt, it is "ok".\n' +
  "NOT-the-agent's-fault — mark these \"ok\", do NOT flag as an issue:\n" +
  '- CALLER-SIDE: the call was unresolved because the CALLER never stated a request, stayed silent, ' +
  'hung up, or gave input too unclear to make out — and the agent prompted appropriately (asked them ' +
  'to repeat, or "are you still there?"). That is the caller, not an agent failure.\n' +
  '- KNOWLEDGE IT CANNOT KNOW: the caller asked something the agent was never given the information for ' +
  '(a price not in its brief, whether the garage does warranty work, the status of an EXISTING booking ' +
  'it cannot look up) AND the agent correctly offered a callback / took a message. Not knowing ' +
  'garage-specific info it was never given is correct handling = "ok". Only flag if it gave WRONG info ' +
  'or failed to offer a message/callback.\n' +
  '- NO AVAILABILITY: flag "no_availability" ONLY if the agent did NOT offer an alternative. If it gave ' +
  'the next available date/slot (even if not the day the caller wanted), that is correct handling = "ok".\n' +
  'Be specific and concrete; cite the exact tool error or mis-heard value. NEVER invent a problem the ' +
  'trace does not show. If a tool errored but the agent RECOVERED and the call still achieved its ' +
  'outcome (e.g. the booking was still confirmed, the message still taken), that is NOT an issue — ' +
  'only flag tool errors that actually broke the result. ' +
  'ALSO judge SPEED. For dead air, use ONLY the "REAL DEAD AIR" number in the TIMING line — it has ' +
  'ALREADY EXCLUDED the agent\'s intentional ~5s registration/postcode read-back pause (that pause is ' +
  'expected behaviour and must NEVER be flagged). Flag dead air as an issue ONLY when that REAL DEAD ' +
  'AIR number is over ~5s — that means the caller waited too long at a NON-read-back point (e.g. a 13s ' +
  'gap mid-conversation where the agent failed to respond and had to ask "are you still there?"). ' +
  'IGNORE the "for reference" longest-gap-including-read-back number for the dead-air decision. ' +
  'A slowest time-to-first-word over ~4s is also a slow-reply issue. State the number of seconds. ' +
  'Use the CAPTURE line: 2+ registration/postcode restarts (or "NOT captured") is a struggle worth ' +
  'flagging as an issue; 0-1 restarts is fine. ' +
  'When status is "issue", also set "category" to the SINGLE best-fitting failure type from EXACTLY ' +
  'this list (so similar failures group together for trends): "booking_failure" (a booking could not ' +
  'be completed / GarageHive rejected it), "no_availability" (no slots), "reg_postcode_struggle" ' +
  '(hard to capture the reg or postcode), "misheard" (agent mis-heard a value and did not correct it), ' +
  '"dead_air" (long silence / slow response), "transfer_failed", "wrong_info" (agent gave wrong info, ' +
  'hallucinated, or ignored its brief), "unresolved" (caller\'s need not met / confusion), "other". ' +
  'For status "ok", set "category" to "none". ' +
  'Reply ONLY as JSON: {"status":"ok"|"issue","headline":"<= 8 words","detail":"1-3 plain sentences",' +
  '"suggestedAction":"<= 1 sentence, or empty string","category":"<one value from the list above>"}.';

export async function analyzeCall(input: {
  transcript: unknown;
  metrics: unknown;
  summary?: string;
  callType?: string;
  confirmedBooking?: boolean;
  model?: string;
}): Promise<CallDiagnosis | null> {
  const oa = getClient();
  if (!oa) {
    console.warn('[DIAGNOSIS] OPENAI_API_KEY not set — skipping');
    return null;
  }
  const model = input.model || 'gpt-4o-mini';
  const userMsg =
    `Call type: ${input.callType || 'unknown'} | Booking confirmed: ${input.confirmedBooking ? 'yes' : 'no'}\n` +
    `Summary: ${input.summary || '(none)'}\n\n` +
    `TOOL TIMELINE:\n${buildToolTimeline(input.metrics)}\n\n` +
    `TIMING: ${buildTiming(input.metrics, input.transcript)}\n\n` +
    `TURN GAPS (longest caller->agent waits — check whether the biggest one is right before a reg/postcode read-back):\n${buildTurnGaps(input.transcript)}\n\n` +
    `CAPTURE: ${buildCapture(input.metrics)}\n\n` +
    `TRANSCRIPT:\n${buildTranscript(input.transcript)}`;
  try {
    const r = await oa.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
    });
    const p = JSON.parse(r.choices[0]?.message?.content || '{}');
    let status: 'ok' | 'issue' = p.status === 'issue' ? 'issue' : 'ok';
    let category = p.category ? String(p.category).slice(0, 40) : (p.status === 'issue' ? 'other' : 'none');
    let headline = String(p.headline || '').slice(0, 120);
    let detail = String(p.detail || '').slice(0, 800);
    let suggestedAction = p.suggestedAction ? String(p.suggestedAction).slice(0, 300) : undefined;
    // FALSE-POSITIVE GUARD for dead air. The transcript-gap silence measure charges a caller's own
    // pause (they speak, then hold the line before their turn truly ends) to the agent. The
    // authoritative measure is response_gap (end-of-utterance delay) — the wait AFTER the caller
    // actually stops talking. EOU can exceed 3s (that is exactly what slow_responses_over_3s counts),
    // so a genuine agent silence always registers there; if it did not, the agent demonstrably replied
    // fast on every measured turn and the long transcript gap was caller-side. Neutralise the spurious flag.
    const lat = (input.metrics as { latency?: Record<string, number> })?.latency ?? {};
    const gapMax = typeof lat.response_gap_max_s === 'number' ? lat.response_gap_max_s : null;
    const slow = typeof lat.slow_responses_over_3s === 'number' ? lat.slow_responses_over_3s : null;
    const turns = typeof lat.turns_measured === 'number' ? lat.turns_measured : 0;
    if (category === 'dead_air' && gapMax !== null && gapMax < 3 && slow === 0 && turns > 0) {
      console.log(`[DIAGNOSIS] dead_air suppressed: agent reply gap max ${gapMax}s, 0 slow over ${turns} turns — caller-side pause`);
      status = 'ok';
      category = 'none';
      headline = 'No agent dead air (caller pause)';
      detail = `Initially flagged as dead air, but the agent replied within ${gapMax}s of the caller ` +
        `finishing speaking on every turn (0 slow responses over ${turns} turns). The long silence in the ` +
        `transcript was the caller pausing or holding the line, not the agent going quiet.`;
      suggestedAction = undefined;
    }
    return {
      status,
      headline,
      detail,
      suggestedAction,
      category,
      model,
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error('[DIAGNOSIS] OpenAI analysis failed:', e);
    return null;
  }
}

// Render the raw GarageHive request/response pairs (the real validation reasons live here).
function buildGhTrace(metrics: unknown): string {
  const tr = (metrics as { gh_trace?: unknown })?.gh_trace;
  if (!Array.isArray(tr) || tr.length === 0) return '(no GarageHive API calls on this call)';
  return tr
    .map((g: Record<string, unknown>, i: number) =>
      `${i + 1}. ${g.method} ${g.path} ${JSON.stringify(g.payload ?? {}).slice(0, 200)} ` +
      `-> HTTP ${g.status}: ${String(g.response ?? '').slice(0, 300)}`)
    .join('\n');
}

// The longest customer->agent waits, with the surrounding turns, so the deep-dive can pinpoint
// WHERE a silence happened (not just that the max gap was N seconds).
function buildTurnGaps(transcript: unknown): string {
  if (!Array.isArray(transcript)) return '(n/a)';
  const msgs = transcript
    .filter((m: Record<string, unknown>) => (m.type ?? 'message') === 'message' && (m.text ?? m.content))
    .map((m: Record<string, unknown>) => {
      const who = m.speaker ?? m.role;
      const ts = typeof m.timestamp === 'number' ? m.timestamp : (typeof m.ts === 'number' ? m.ts : null);
      return { spk: who === 'agent' || who === 'assistant' ? 'agent' : 'customer', ts, text: String(m.text ?? m.content ?? '').slice(0, 45) };
    })
    .filter((m) => m.ts !== null) as { spk: string; ts: number; text: string }[];
  const gaps: { gap: number; caller: string; agent: string }[] = [];
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].spk === 'agent' && msgs[i - 1].spk === 'customer') {
      gaps.push({ gap: Math.round((msgs[i].ts - msgs[i - 1].ts) * 10) / 10, caller: msgs[i - 1].text, agent: msgs[i].text });
    }
  }
  gaps.sort((a, b) => b.gap - a.gap);
  if (!gaps.length) return '(no caller->agent turns)';
  return gaps.slice(0, 3)
    .map((g) => `${g.gap}s gap: caller said "${g.caller}" then waited ${g.gap}s for the agent's "${g.agent}…"`)
    .join('\n');
}

// What I know about how this agent works — gives the deep-dive the mechanism knowledge it needs to
// diagnose precisely (e.g. recognise a 5s pause before a reg read-back as the intentional timer).
const AGENT_BEHAVIOURS =
  'KNOWN AGENT BEHAVIOURS (use these to explain timing and flow precisely):\n' +
  '- After the caller gives a registration that is COMPLETE but shorter than 7 characters (e.g. a ' +
  'personalised/older plate), the agent INTENTIONALLY waits ~5 seconds of silence before reading it ' +
  'back, in case they are still spelling. So a ~5-8s pause IMMEDIATELY BEFORE a reg read-back is this ' +
  'timer (expected behaviour), not general model slowness. A full 7-char plate is read back instantly.\n' +
  '- If the caller goes quiet, the agent waits ~12.5s then re-prompts "are you still there?". A ~12s+ ' +
  'gap followed by that phrase is the inactivity timer (usually the caller went silent, not the agent).\n' +
  '- The model sometimes drops a plate\'s leading letter A, mishearing the spoken "A" as the article ' +
  '"a" (e.g. "it\'s a P21 FJX" relayed as "P21FJX").\n' +
  '- GarageHive set-contact-info REQUIRES a salutation + a last name, or it returns HTTP 422.\n' +
  '- Booking chain: init -> set-vehicle-info -> list-services -> set-services -> list-timeslots -> ' +
  'set-timeslot -> set-contact-info. Calling set_service before list_services returns "Call ' +
  'list_services first" — a harmless self-correcting retry (~1s wasted), NOT a real fault.\n' +
  '- The agent books against the live GarageHive diary via list_timeslots; the portal "Allow bookings" ' +
  'toggle does NOT apply to it.';

const DEEP_SYSTEM_PROMPT =
  'You are a senior voice-AI engineer doing ROOT-CAUSE analysis on a flagged call for ReceptionMate ' +
  '(an AI phone receptionist for UK car garages). You are given the full trace: the spoken transcript, ' +
  "the agent's tool calls with their inputs and results, the RAW GarageHive request/response bodies, " +
  'the per-turn TURN GAPS (so you know exactly which silence happened where), the timing summary, ' +
  "registration/postcode capture stats, AND the agent's own instructions for this call (its prompt, " +
  'including the garage-specific custom rules). Use the instructions to judge whether the agent ' +
  'followed its brief or whether the brief itself caused the problem — but remember the prompt does ' +
  'NOT contain code-level timers/state machines, which are listed below.\n\n' +
  AGENT_BEHAVIOURS +
  '\n\nWork out the SPECIFIC technical root cause (cite the exact tool error, GH response, mis-heard ' +
  'value, or timing event — and pin a silence to the turn it occurred on using TURN GAPS). Give a ' +
  'CONCRETE, actionable fix at the prompt / config / code level. If a pause matches a known intentional ' +
  'behaviour above (e.g. the 5s read-back timer), SAY SO rather than calling it a misconfiguration. ' +
  'Be precise and technical; do NOT invent a cause not supported by the trace. ' +
  'Reply ONLY as JSON: {"rootCause":"2-4 specific sentences","fix":"1-3 concrete sentences","severity":"low|medium|high"}.';

// Deep root-cause + fix analysis. Auto-run when triage flags an issue, or via the call-page button.
// Reads the richer trace (GH bodies, tool args) and uses a stronger model by default.
export async function analyzeDeep(input: {
  transcript: unknown;
  metrics: unknown;
  summary?: string;
  callType?: string;
  confirmedBooking?: boolean;
  triage?: { headline?: string; detail?: string };
  model?: string;
}): Promise<{ rootCause: string; fix: string; severity: 'low' | 'medium' | 'high'; model: string } | null> {
  const oa = getClient();
  if (!oa) return null;
  const model = input.model || 'gpt-4o';
  const userMsg =
    `Triage flagged: ${input.triage?.headline || ''} — ${input.triage?.detail || ''}\n` +
    `Call type: ${input.callType || 'unknown'} | Booking confirmed: ${input.confirmedBooking ? 'yes' : 'no'}\n` +
    `Summary: ${input.summary || '(none)'}\n\n` +
    `TOOL TIMELINE (with inputs):\n${buildToolTimeline(input.metrics)}\n\n` +
    `GARAGEHIVE TRACE:\n${buildGhTrace(input.metrics)}\n\n` +
    `TIMING: ${buildTiming(input.metrics, input.transcript)}\n\n` +
    `TURN GAPS (longest caller->agent waits):\n${buildTurnGaps(input.transcript)}\n\n` +
    `CAPTURE: ${buildCapture(input.metrics)}\n\n` +
    `THE AGENT'S OWN INSTRUCTIONS FOR THIS CALL (what it was told to do, incl. this garage's custom ` +
    `rules — use this to judge whether the agent followed its brief or the brief itself is at fault):\n` +
    `${String((input.metrics as { agent_prompt?: unknown })?.agent_prompt ?? '(not captured for this call)').slice(0, 6000)}\n\n` +
    `TRANSCRIPT:\n${buildTranscript(input.transcript)}`;
  try {
    const r = await oa.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: DEEP_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
    });
    const p = JSON.parse(r.choices[0]?.message?.content || '{}');
    const sev = p.severity === 'high' || p.severity === 'medium' || p.severity === 'low' ? p.severity : 'medium';
    return {
      rootCause: String(p.rootCause || '').slice(0, 1200),
      fix: String(p.fix || '').slice(0, 800),
      severity: sev,
      model,
    };
  } catch (e) {
    console.error('[DIAGNOSIS] deep analysis failed:', e);
    return null;
  }
}
