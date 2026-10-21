/**
 * Reads a call the way an engineer who owns the agent reads it, and returns a
 * LIST of what went wrong.
 *
 * This exists because `analyzeCall` cannot. Its output shape is one verdict —
 * `status: ok | issue` plus a single `category` — so a call with two
 * independent faults has room to report one. On call 16056346 it described how
 * the agent asked for the caller's name, concluded "failedBy: caller", and the
 * registration the agent had never been told had nowhere to go. A classifier
 * cannot report two things.
 *
 * It also reaches the data `analyzeCall` never sees: `buildGhTrace` has existed
 * for weeks and is only wired into the deep pass, so registration lookups have
 * never reached the per-call review at all.
 *
 * The rules Dan has corrected me on are enforced in `normalizeFindings`, in
 * code, not in the prompt. The prompt carries them too, but the Elite Autocare
 * calls proved that an instruction a model may ignore is not a rule — the model
 * was told, had the capability list, and blamed the agent anyway.
 */
import OpenAI from 'openai';

import {
  buildAgentContext, buildCapture, buildGhTrace, buildTiming,
  buildToolTimeline, buildTranscript, buildTurnGaps, impossibleForAgent,
} from './callDiagnosis.js';

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

/** Closed set, so the observability panel can group and trend them. */
export const FAULT_CATEGORIES = [
  'dead_air',            // the caller waited too long at a point that was not a read-back
  'misheard',            // a value heard wrong and never corrected
  'reg_struggle',        // registration or postcode capture went badly
  'repeated_question',   // asked for something the caller had already given
  'wrong_info',          // stated something untrue, invented, or against its brief
  'promise_not_kept',    // promised an email, a callback or a booking that never happened
  'tool_failure',        // a tool errored or never completed
  'booking_failure',     // a booking could not be completed
  'unverified_vehicle',  // acted on a vehicle the caller never confirmed
  'rushed_readback',     // read a value back too fast to check
  'summary_wrong',       // the call summary does not match the call
  'unresolved',          // the caller did not get what they rang for, and it was ours
  'other',
] as const;
export type FaultCategory = (typeof FAULT_CATEGORIES)[number];

export interface CallFault {
  category: FaultCategory;
  severity: 'high' | 'medium' | 'low';
  headline: string;
  detail: string;
  evidence?: string;
}

const SEVERITIES = ['high', 'medium', 'low'] as const;
const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

// Six is enough to describe a bad call and few enough that one call cannot bury
// a day's worth of others on the page.
const MAX_FINDINGS = 6;

// A fault about getting a booking made is meaningless where there is no diary
// to book into. "An agent with no diary isnt a failure" — taking a message IS
// the success there.
const NEEDS_A_DIARY: string[] = ['booking_failure', 'unresolved'];

export function normalizeFindings(
  raw: unknown,
  ctx: { capabilities?: Record<string, boolean>; hasDiary: boolean },
): CallFault[] {
  if (!Array.isArray(raw)) return [];
  const out: CallFault[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;

    const detail = String(r.detail ?? '').trim();
    if (!detail) continue; // a finding with nothing to read is not reportable

    const category = (FAULT_CATEGORIES as readonly string[]).includes(String(r.category))
      ? (String(r.category) as FaultCategory)
      : 'other';
    let severity = (SEVERITIES as readonly string[]).includes(String(r.severity))
      ? (String(r.severity) as CallFault['severity'])
      : 'medium';

    // The caller interrupting the agent is the barge-in handling working.
    if (/\binterrupt/i.test(detail)) continue;

    // The ~5s mute while the agent reads a registration or postcode back is
    // deliberate. It is the single most-reported non-fault.
    if (category === 'dead_air' && (/read[-\s]?back/i.test(detail) || /\bread\b.*\bback\b/i.test(detail))) continue;

    // No diary means no booking was ever possible.
    if (!ctx.hasDiary && NEEDS_A_DIARY.includes(category)) continue;

    // A request the agent had no tool for is not the agent's failure. The model
    // is asked to pass back the caller's intent precisely so this can be checked
    // in code rather than trusted to the prompt.
    const intent = typeof r.callerIntent === 'string' ? r.callerIntent : '';
    if (intent && impossibleForAgent(intent, ctx.capabilities, ctx.hasDiary)) continue;

    // A message that did not save is a data-quality fault, not a lost lead:
    // every call over 30 seconds is written to the portal and emailed to the
    // garage, so the garage hears about it either way.
    if (category === 'tool_failure' && /message/i.test(detail) && severity === 'high') {
      severity = 'medium';
    }

    out.push({
      category,
      severity,
      headline: String(r.headline ?? '').trim().slice(0, 120),
      detail: detail.slice(0, 700),
      evidence: typeof r.evidence === 'string' && r.evidence.trim()
        ? r.evidence.trim().slice(0, 300)
        : undefined,
    });
  }

  // Worst first, so the cap never cuts a high finding to keep a low one.
  out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return out.slice(0, MAX_FINDINGS);
}

/**
 * The FINAL outcome of each tool, which is the only one that counts.
 *
 * The raw timeline lists every call, and tools legitimately return an
 * intermediate status before succeeding — `confirm_booking` asks the caller to
 * confirm their number (CONFIRM_NUMBER) and then places the booking (OK). On
 * call 44318520 the analyst read that first status as a failure and reported
 * the summary as claiming a booking that had in fact been placed. Stating the
 * last status per tool removes the guess.
 */
function buildToolOutcomes(metrics: unknown): string {
  const m = (metrics ?? {}) as Record<string, unknown>;
  const history = Array.isArray(m.tool_call_history) ? m.tool_call_history : [];
  if (!history.length) return '(no tools were called)';
  const last = new Map<string, { status: string; calls: number }>();
  for (const h of history as Record<string, unknown>[]) {
    const tool = String(h?.tool ?? '').trim();
    if (!tool) continue;
    const status = String(h?.status ?? '').replace(/^\s*STATUS:\s*/i, '').split('—')[0].trim();
    const prev = last.get(tool);
    last.set(tool, { status, calls: (prev?.calls ?? 0) + 1 });
  }
  return [...last.entries()]
    .map(([tool, v]) => `${tool}: ended ${v.status || '(no status)'}`
      + `${v.calls > 1 ? ` (called ${v.calls}x; earlier statuses were steps along the way, not failures)` : ''}`)
    .join('\n');
}

const SYSTEM_PROMPT = [
  'You review completed calls handled by an AI receptionist for a UK garage, the way an engineer',
  'who owns that agent would: you are looking for what went WRONG, so it can be fixed.',
  '',
  'Report EVERY fault you find as its own entry. Faults are independent — a call can have none,',
  'one, or several, and a mistake about the vehicle does not stop being a mistake because the',
  'message was taken properly. If the call was handled well, return an empty list. Never invent a',
  'fault to have something to say, and never report a fault the trace does not show.',
  '',
  'Read all of it: the transcript as a conversation, the gaps between turns, the tool calls with',
  'their arguments and results, the registration lookups, the capture counters, and the summary.',
  'Quote the words that show the fault in "evidence".',
  '',
  'LOOK FOR, among anything else you notice:',
  '- the caller waiting with no reply (use the REAL DEAD AIR figure, never the read-back pause)',
  '- a registration, postcode, name, phone number or email heard wrong and not corrected',
  '- a value read back so fast or so run-together that the caller could not check it',
  '- the agent asking again for something the caller had already given',
  '- the agent acting on a vehicle the caller never confirmed (check the lookups against what the',
  '  caller actually said about their car — make, model, anything)',
  '- the agent saying something untrue, invented, or against its brief, including prices',
  '- the agent promising an email, a callback, a booking or a transfer that the tools never did',
  '- a tool that errored, or gathered everything and never completed. Judge this ONLY on how the',
  '  tool ENDED: a status part-way through a flow is a step, not a failure, and a tool called',
  '  several times is judged on its last result alone.',
  '- a summary that does not match what happened on the call',
  '- the caller not getting what they rang for, where the agent or the diary caused it',
  '- the agent asking for a NAME or other details BEFORE helping with what the caller rang about.',
  '  Callers hang up on that: it is the single biggest cause of calls dying under 30 seconds.',
  '  If the caller stated their business and the agent\'s next move was to collect details',
  '  instead of addressing it, that is an agent fault even if the caller then went quiet.',
  '',
  'NOT FAULTS. Do not report these, however tempting:',
  '- NO BOOKING on its own. Many callers only want information, or decide not to book.',
  '- a garage with NO DIARY being unable to book. Taking a message IS the right outcome there.',
  '- a question no system can answer: whether the car is READY, whether it can be dropped off',
  '  EARLIER, how long work will take. Workshop capacity is in someone\'s head, not an API.',
  '  Offering a message or a callback is correct handling.',
  '- a tool the agent was NOT GIVEN (see the capability list). A cancellation at a garage without',
  '  cancel, or a booking lookup without retrieve_booking, is not the agent\'s failure.',
  '- the ~5 second pause while the agent reads a registration or postcode back. Deliberate.',
  '- the CALLER interrupting the agent. That is the barge-in handling working correctly.',
  '- the caller never saying what they wanted, staying silent, or hanging up, where the agent',
  '  prompted properly. This excuses the agent ONLY when the caller gave it nothing to work with.',
  '  A caller who said what they wanted and then went quiet while being asked for details is NOT',
  '  this case — look at what the agent asked them for.',
  '- no availability, where the agent offered the next alternative.',
  '- caller recognition supplying the vehicle. That is normal; only flag it if the vehicle looks',
  '  WRONG for what the caller said.',
  '- "Thanks for calling" at the end. That is the goodbye, not a second greeting.',
  '',
  'SEVERITY: "high" when a customer was harmed or misled — a wrong vehicle acted on, wrong',
  'information given, a promise not kept, a booking lost. "medium" when the handling was poor but',
  'recoverable. "low" for wording and polish.',
  '',
  'Set "callerIntent" to a few plain words for what the caller rang about, on every finding —',
  'it is checked against what the agent was actually able to do.',
  '',
  'Reply ONLY as JSON: {"findings":[{"category":"<one of: ' + FAULT_CATEGORIES.join(', ') + '>",',
  '"severity":"high"|"medium"|"low","headline":"<= 10 words","detail":"1-3 plain sentences saying',
  'what went wrong and why it matters","evidence":"<a short quote from the call, or empty>",',
  '"callerIntent":"<a few plain words>"}]}. An empty findings array is the correct answer for a',
  'call that went well.',
].join('\n');

export async function findCallFaults(input: {
  transcript: unknown;
  metrics: unknown;
  summary?: string;
  callType?: string;
  confirmedBooking?: boolean;
  model?: string;
  /**
   * What the deterministic scan already established about this call.
   *
   * Call 16056346 is why this exists. The plate the agent acted on was never
   * spoken by the caller — but nothing in the context SAID so. The capture line
   * read "registration: captured after 0 restart(s)", which looks like success,
   * and the model duly read past it exactly as I had. Facts the field data
   * proves are stated here rather than left to be re-derived from a counter.
   */
  knownSignals?: string[];
}): Promise<{ findings: CallFault[]; model: string } | null> {
  const oa = getClient();
  if (!oa) {
    console.warn('[FAULTS] OPENAI_API_KEY not set — skipping');
    return null;
  }
  // Not the triage model. gpt-4o-mini is what read past a plate the caller had
  // never said and called the call caller-fault.
  const model = input.model || process.env.CALL_FAULT_MODEL || 'gpt-4.1';

  const m = (input.metrics ?? {}) as Record<string, unknown>;
  const capabilities = (m.diary_capabilities ?? undefined) as Record<string, boolean> | undefined;
  const hasDiary = Boolean(m.diary) || Boolean(capabilities && Object.keys(capabilities).length);

  const known = (input.knownSignals || []).filter(Boolean);
  const userMsg =
    (known.length
      // Without the "do not repeat" instruction it dutifully restated each one:
      // over 124 calls the analyst returned 19 unverified-vehicle findings
      // against the data checks' 19, which doubles the page and adds nothing.
      ? `ALREADY FOUND BY THE DATA CHECKS AND ALREADY ON THE RECORD. Do NOT report any of these `
        + `again. Treat them as established fact, and report only faults they do NOT cover — for `
        + `instance what the agent went on to tell the caller, or what the garage was told in the `
        + `summary, about the thing below:\n${known.map((k) => `- ${k}`).join('\n')}\n\n`
      : '')
    + `Call type: ${input.callType || 'unknown'} | Booking confirmed: ${input.confirmedBooking ? 'yes' : 'no'}\n`
    + `Summary the garage was sent: ${input.summary || '(none)'}\n\n`
    + `THIS GARAGE'S AGENT (what it was and was not given):\n${buildAgentContext(input.metrics)}\n\n`
    + `TOOL TIMELINE (arguments and results):\n${buildToolTimeline(input.metrics)}\n\n`
    // The timeline alone made it read a mid-flow status as a failure.
    + `HOW EACH TOOL ACTUALLY ENDED (judge success or failure ONLY on these):\n`
    + `${buildToolOutcomes(input.metrics)}\n\n`
    // Registration lookups. Built weeks ago and never wired into the per-call
    // review, so no per-call pass has ever seen what the lookups returned.
    + `VEHICLE / DIARY LOOKUPS:\n${buildGhTrace(input.metrics)}\n\n`
    + `TIMING: ${buildTiming(input.metrics, input.transcript)}\n\n`
    + `TURN GAPS (longest caller->agent waits; the biggest is often the deliberate read-back pause):\n${buildTurnGaps(input.transcript)}\n\n`
    + `CAPTURE: ${buildCapture(input.metrics)}\n\n`
    + `TRANSCRIPT:\n${buildTranscript(input.transcript)}`;

  try {
    const r = await oa.chat.completions.create({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
    });
    const parsed = JSON.parse(r.choices[0]?.message?.content || '{}');
    return {
      findings: normalizeFindings(parsed.findings, { capabilities, hasDiary }),
      model,
    };
  } catch (err) {
    console.error('[FAULTS] analysis failed:', (err as Error)?.message);
    return null;
  }
}
