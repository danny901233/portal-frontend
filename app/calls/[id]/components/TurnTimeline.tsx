'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, Gauge } from 'lucide-react';

/**
 * Turn-by-turn latency, the way LiveKit's own session view shows it.
 *
 * The agents have always recorded this — per agent turn the LLM's time to first token, the TTS
 * time to first byte and the end-to-end reply time; per caller turn the STT transcription delay.
 * The comment in the agent says why: "so the portal can show WHICH turn stalled, not just the
 * call-level max." Until now nothing rendered it, so a call with a four-second gap told you it
 * had one but not where.
 *
 * Two clocks are shown deliberately, because they answer different questions:
 *   • MEASURED  — what the pipeline spent (ttft + ttfb, summing to e2e). Our latency.
 *   • GAP       — wall-clock between one message and the next, from the transcript. This includes
 *                 the caller thinking, and the endpointing delay before we even start. A long gap
 *                 with a short measured time is the turn detector waiting, not the model being
 *                 slow — which is exactly the distinction needed when judging endpointing changes.
 */

export interface TurnMetric {
  e2e?: number;
  ttft?: number;
  ttfb?: number;
  stt_delay?: number;
}

interface TranscriptLike {
  speaker?: string;
  text?: string;
  timestamp?: number;
  type?: string;
}

interface TurnTimelineProps {
  turns: TurnMetric[];
  transcript: TranscriptLike[];
  /** Seek the audio player to this call-relative second. */
  onSeek?: (seconds: number) => void;
}

type Row = {
  role: 'agent' | 'customer';
  text: string;
  at: number | null;
  gap: number | null;
  metric: TurnMetric | null;
};

/** A row carrying stt_delay is a caller turn; anything with e2e/ttft/ttfb is an agent turn. */
const roleOf = (m: TurnMetric): 'agent' | 'customer' =>
  m.stt_delay !== undefined ? 'customer' : 'agent';

/**
 * Pair metrics to transcript lines by walking both in order and matching on role.
 *
 * The agent appends a metrics row per conversation item, but only when the SDK actually gave it
 * one — so the two lists can drift out of step. Matching on role rather than index means a
 * dropped row costs one unmatched line instead of misaligning everything after it.
 */
function buildRows(turns: TurnMetric[], transcript: TranscriptLike[]): Row[] {
  const messages = transcript.filter(
    (e) => (e.type ?? 'message') === 'message' && (e.speaker === 'agent' || e.speaker === 'customer'),
  );
  const rows: Row[] = [];
  let t = 0;
  let prevAt: number | null = null;

  for (const msg of messages) {
    const role = msg.speaker === 'agent' ? 'agent' : 'customer';
    let metric: TurnMetric | null = null;
    if (t < turns.length && roleOf(turns[t]) === role) {
      metric = turns[t];
      t += 1;
    }
    const at = typeof msg.timestamp === 'number' ? msg.timestamp : null;
    rows.push({
      role,
      text: (msg.text ?? '').trim(),
      at,
      gap: at !== null && prevAt !== null ? Math.max(0, at - prevAt) : null,
      metric,
    });
    if (at !== null) prevAt = at;
  }
  return rows;
}

const fmt = (n: number | undefined | null) =>
  n === undefined || n === null ? '—' : `${n.toFixed(2)}s`;

/** Thresholds match the agent's own: it counts a reply "slow" over 3s. */
function toneFor(e2e: number | undefined): { bar: string; text: string } {
  if (e2e === undefined) return { bar: 'bg-slate-300', text: 'text-slate-500' };
  if (e2e >= 3) return { bar: 'bg-rose-500', text: 'text-rose-600' };
  if (e2e >= 1.5) return { bar: 'bg-amber-500', text: 'text-amber-600' };
  return { bar: 'bg-emerald-500', text: 'text-emerald-600' };
}

export function TurnTimeline({ turns, transcript, onSeek }: TurnTimelineProps) {
  const [open, setOpen] = useState(false);

  const rows = useMemo(() => buildRows(turns, transcript), [turns, transcript]);

  const scale = useMemo(() => {
    // Scale the bars against the slowest reply in THIS call, floored at 3s so a uniformly fast
    // call doesn't render its 0.4s replies as alarming full-width bars.
    const worst = rows.reduce((m, r) => Math.max(m, r.metric?.e2e ?? 0), 0);
    return Math.max(3, worst);
  }, [rows]);

  const slowest = useMemo(() => {
    let idx = -1;
    let worst = 0;
    rows.forEach((r, i) => {
      if ((r.metric?.e2e ?? 0) > worst) {
        worst = r.metric?.e2e ?? 0;
        idx = i;
      }
    });
    return { idx, value: worst };
  }, [rows]);

  const measured = rows.filter((r) => r.metric?.e2e !== undefined).length;
  if (!rows.length || !turns.length) return null;

  return (
    <section className="rounded-2xl bg-white ring-1 ring-slate-200">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left md:px-5"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2.5">
          <Gauge className="h-4 w-4 text-slate-400" aria-hidden />
          <span className="text-sm font-semibold text-slate-800">Turn-by-turn timing</span>
          <span className="text-xs text-slate-500">
            {measured} replies measured
            {slowest.value > 0 ? ` · slowest ${slowest.value.toFixed(2)}s` : ''}
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="border-t border-slate-100 px-4 pb-4 md:px-5">
          <div className="flex flex-wrap gap-x-5 gap-y-1 pt-3 pb-1 text-[11px] text-slate-500">
            <span><b className="font-semibold text-slate-700">gap</b> — wall clock since the previous line</span>
            <span><b className="font-semibold text-slate-700">stt</b> — transcription delay</span>
            <span><b className="font-semibold text-slate-700">llm</b> — first token</span>
            <span><b className="font-semibold text-slate-700">tts</b> — first audio</span>
            <span><b className="font-semibold text-slate-700">total</b> — end to end</span>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[560px] divide-y divide-slate-100">
              {rows.map((r, i) => {
                const m = r.metric;
                const tone = toneFor(m?.e2e);
                const isSlowest = i === slowest.idx && slowest.value >= 1.5;
                const ttftPct = m?.ttft ? Math.min(100, (m.ttft / scale) * 100) : 0;
                const ttfbPct = m?.ttfb ? Math.min(100 - ttftPct, (m.ttfb / scale) * 100) : 0;

                return (
                  <div
                    key={`${r.role}-${i}`}
                    className={`grid grid-cols-[3.2rem_1fr_13rem] items-start gap-3 py-2 ${
                      isSlowest ? 'bg-rose-50/60' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => (r.at !== null && onSeek ? onSeek(r.at) : undefined)}
                      disabled={r.at === null || !onSeek}
                      className="pt-0.5 text-left font-mono text-[11px] text-slate-400 enabled:hover:text-brand-600 enabled:hover:underline disabled:cursor-default"
                      title={r.at !== null && onSeek ? 'Jump to this point in the recording' : undefined}
                    >
                      {r.at !== null ? `${Math.floor(r.at / 60)}:${String(Math.floor(r.at % 60)).padStart(2, '0')}` : '—'}
                    </button>

                    <div className="min-w-0">
                      <p className="truncate text-xs text-slate-700">
                        <span
                          className={`mr-1.5 font-semibold ${
                            r.role === 'agent' ? 'text-brand-600' : 'text-slate-500'
                          }`}
                        >
                          {r.role === 'agent' ? 'Agent' : 'Caller'}
                        </span>
                        {r.text || <span className="italic text-slate-400">(no text)</span>}
                      </p>
                      {r.role === 'agent' && m ? (
                        <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                          <div className="h-full bg-indigo-400" style={{ width: `${ttftPct}%` }} title={`LLM ${fmt(m.ttft)}`} />
                          <div className="h-full bg-sky-400" style={{ width: `${ttfbPct}%` }} title={`TTS ${fmt(m.ttfb)}`} />
                        </div>
                      ) : null}
                    </div>

                    <div className="text-right font-mono text-[11px] leading-5">
                      {r.gap !== null ? (
                        <span className={r.gap >= 4 ? 'text-amber-600' : 'text-slate-400'}>gap {fmt(r.gap)}</span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                      {m?.stt_delay !== undefined ? (
                        <span className="ml-2 text-slate-500">stt {fmt(m.stt_delay)}</span>
                      ) : null}
                      {r.role === 'agent' && m ? (
                        <div className={tone.text}>
                          <span className="text-slate-400">llm {fmt(m.ttft)} · tts {fmt(m.ttfb)} · </span>
                          <b className="font-semibold">total {fmt(m.e2e)}</b>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <p className="pt-3 text-[11px] leading-relaxed text-slate-500">
            A long <b>gap</b> with a short <b>total</b> is the caller thinking, or the turn detector
            waiting before we start — not the model being slow. Bars are scaled against the slowest
            reply in this call (minimum 3s).
          </p>
        </div>
      ) : null}
    </section>
  );
}
