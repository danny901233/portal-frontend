/**
 * The caller's side of a call transcript, rebuilt from the call RECORDING.
 *
 * Dan, 5 Nov 2026: "on a lot of our calls the transcript is not matching what was said out loud".
 * Checked against the recording of Elite 67195486: the agent's lines were right, the caller's were
 * not — the live (streaming) speech-to-text wrote "Fair enough." for the caller's name and "x t v"
 * for "XTB", and a batch pass over the recording got both right. So the agent's lines, and the tool
 * steps between them, stay exactly as the agent logged them; the caller's lines are replaced by the
 * batch transcript of the recording.
 *
 * Which recording utterances are the AGENT is decided by what the agent actually said, not by the
 * diarizer's speaker id alone: on short lines it puts the agent on the caller's id. Everything is
 * placed on the live transcript's clock, offset by matching the agent's own lines. If the two do not
 * line up, the live transcript is left alone — a wrong merge is worse than a misheard word.
 */

export interface TranscriptEntry {
  type: string;
  speaker?: string;
  text?: string;
  timestamp?: number;
  [k: string]: unknown;
}

export interface Utterance {
  start: number;
  end: number;
  speaker: number;
  transcript: string;
}

const words = (t: string): string[] =>
  String(t || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

/** How much of the longer of the two lines the shorter shares: "Mira." is not "...is it Mira?". */
function likeness(a: string, b: string): number {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.max(A.size, B.size);
}

const AGENT_MATCH = 0.5;

export function mergeRecordingTranscript(
  live: TranscriptEntry[],
  utterances: Utterance[],
  opts: { transferAtSeconds?: number | null } = {},
): TranscriptEntry[] | null {
  const agentLines = (live || []).filter((e) => e.type === 'message' && e.speaker === 'agent' && e.text);
  const utts = (utterances || []).filter((u) => String(u.transcript || '').trim());
  if (!agentLines.length || !utts.length) return null;

  // Each utterance's best agent line.
  const best = utts.map((u) => {
    let score = 0;
    let line: TranscriptEntry | null = null;
    for (const a of agentLines) {
      const s = likeness(u.transcript, String(a.text));
      if (s > score) { score = s; line = a; }
    }
    return { u, score, line };
  });

  // The diarizer's agent id: the one whose utterances match the agent's words most often.
  const votes = new Map<number, number>();
  for (const b of best) if (b.score >= AGENT_MATCH) votes.set(b.u.speaker, (votes.get(b.u.speaker) || 0) + 1);
  if (!votes.size) return null;
  const agentSpeaker = [...votes.entries()].sort((x, y) => y[1] - x[1])[0][0];

  // The recording's clock to the live one, from the agent's own lines.
  const offsets = best
    .filter((b) => b.score >= AGENT_MATCH && b.line && typeof b.line.timestamp === 'number')
    .map((b) => (b.line!.timestamp as number) - b.u.start)
    .sort((x, y) => x - y);
  if (!offsets.length) return null;
  const offset = offsets[Math.floor((offsets.length - 1) / 2)];

  const cutoff = typeof opts.transferAtSeconds === 'number' && opts.transferAtSeconds > 0
    ? opts.transferAtSeconds : Infinity;
  const callerLines: TranscriptEntry[] = best
    .filter((b) => b.u.speaker !== agentSpeaker && b.score < AGENT_MATCH)
    .map((b) => ({
      type: 'message',
      speaker: 'customer',
      text: String(b.u.transcript).trim(),
      timestamp: Math.round((b.u.start + offset) * 10) / 10,
      source: 'recording',
    }))
    .filter((e) => (e.timestamp as number) <= cutoff);

  const kept = (live || []).filter((e) => !(e.type === 'message' && e.speaker === 'customer'));
  // Stable: equal times keep the live entry first.
  const all = [...kept.map((e, i) => ({ e, k: 0, i })), ...callerLines.map((e, i) => ({ e, k: 1, i }))];
  all.sort((x, y) => (Number(x.e.timestamp ?? 0) - Number(y.e.timestamp ?? 0)) || (x.k - y.k) || (x.i - y.i));
  return all.map((x) => x.e);
}
