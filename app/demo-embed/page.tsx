'use client';

// Compact "Talk to Leah" call UI, designed to be iframed into a modal on the marketing site so a
// visitor never leaves receptionmate.co.uk. The full-page /demo remains for direct links.
//
// Why an iframe rather than porting this into the Astro site: livekit-client lives here, the
// connect/dispatch logic is already proven on /demo, and the marketing site cannot be built
// locally — iterating on WebRTC through blind 3-minute Cloudflare deploys would be miserable.
// A cross-origin frame can still request the microphone provided the parent grants it via
// allow="microphone".
//
// The page paints no background of its own: the modal behind it supplies the chrome.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalAudioTrack, RemoteTrack, Room as RoomType } from 'livekit-client';

type Phase = 'idle' | 'connecting' | 'live' | 'ended' | 'failed';

const VOICES = [
  { key: 'leah', name: 'Leah', desc: 'Warm, neutral British' },
  { key: 'tom', name: 'Tom', desc: 'Friendly Northern male' },
  { key: 'sophie', name: 'Sophie', desc: 'Bright & professional' },
];

export default function DemoEmbedPage() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [voice, setVoice] = useState('leah');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);

  const roomRef = useRef<RoomType | null>(null);
  const micRef = useRef<LocalAudioTrack | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef<{ agent: AnalyserNode | null; caller: AnalyserNode | null }>({
    agent: null,
    caller: null,
  });

  // ── waveform ────────────────────────────────────────────────────────────────────────────────
  // Two-way: one analyser on the agent's track, one on the caller's mic, so the bars move for
  // whoever is talking. Each bar takes the louder of the two sides and is tinted to match, which
  // makes the turn-taking legible — you can see the agent stop and listen.
  //
  // Deliberately hand-rolled rather than pulling in the shader-based visualiser from
  // @livekit/components-react: that would add three packages and a WebGL dependency for what is
  // a row of bars.
  const AGENT_RGB = '52, 38, 207';   // brand-600
  const CALLER_RGB = '100, 112, 237'; // brand-400 — same family, clearly lighter

  /** Attach one side's audio to its own analyser. Safe to call in either order. */
  const attachToWaveform = useCallback((stream: MediaStream, side: 'agent' | 'caller') => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = audioCtxRef.current ?? new Ctx();
      audioCtxRef.current = ctx;
      // Autoplay policy can hand back a suspended context even after a click.
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      // Connected to the analyser ONLY — never to ctx.destination, which would echo the caller
      // back into their own speakers.
      ctx.createMediaStreamSource(stream).connect(analyser);
      analysersRef.current[side] = analyser;
    } catch {
      /* visualisation is decorative — never break the call for it */
    }
  }, []);

  /** Start the render loop. Runs regardless of which sides have attached yet. */
  const startWaveform = useCallback(() => {
    if (rafRef.current) return;
    const BARS = 28;
    const agentBins = new Uint8Array(128);
    const callerBins = new Uint8Array(128);

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      const g = canvas.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const { agent, caller } = analysersRef.current;
      if (agent) agent.getByteFrequencyData(agentBins); else agentBins.fill(0);
      if (caller) caller.getByteFrequencyData(callerBins); else callerBins.fill(0);

      const step = Math.floor(agentBins.length / BARS) || 1;
      const barW = w / (BARS * 1.8);

      for (let i = 0; i < BARS; i++) {
        // Bias toward the lower bins where speech energy actually sits, so the bars move with
        // the voice rather than twitching on sibilance.
        const a = agentBins[i * step] / 255;
        const c = callerBins[i * step] / 255;
        const speaking = c > a ? 'caller' : 'agent';
        const amp = Math.pow(Math.max(a, c), 1.35);
        const barH = Math.max(3, amp * h * 0.9);
        const x = i * (w / BARS) + (w / BARS - barW) / 2;
        const y = (h - barH) / 2;
        g.fillStyle = `rgba(${speaking === 'caller' ? CALLER_RGB : AGENT_RGB}, ${0.35 + amp * 0.65})`;
        g.beginPath();
        g.roundRect(x, y, barW, barH, barW / 2);
        g.fill();
      }
    };
    draw();
  }, []);

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analysersRef.current = { agent: null, caller: null };
    try { micRef.current?.stop(); } catch { /* already stopped */ }
    try { roomRef.current?.disconnect(); } catch { /* already gone */ }
    micRef.current = null;
    roomRef.current = null;
    document.querySelectorAll('audio[data-demo]').forEach((el) => el.remove());
  }, []);

  useEffect(() => cleanup, [cleanup]);

  // call timer — also how the visitor sees the 5-minute cap approaching
  useEffect(() => {
    if (phase !== 'live') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const start = useCallback(async () => {
    setError('');
    setSeconds(0);
    setPhase('connecting');
    try {
      const { Room, RoomEvent, Track, createLocalAudioTrack } = await import('livekit-client');
      const res = await fetch('/api/livekit/demo-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice }),
      });
      if (res.status === 429) throw new Error('You have already tried the demo recently.');
      if (res.status === 503) throw new Error('All demo lines are busy — please try again shortly.');
      if (!res.ok) throw new Error('Could not start the demo.');
      const { token, url } = await res.json();

      const room = new Room();
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach() as HTMLAudioElement;
        el.autoplay = true;
        el.setAttribute('data-demo', '1');
        document.body.appendChild(el);
        const ms = (track as unknown as { mediaStream?: MediaStream }).mediaStream;
        if (ms) attachToWaveform(ms, 'agent');
      });
      room.on(RoomEvent.Disconnected, () => setPhase((prev) => (prev === 'live' ? 'ended' : prev)));

      await room.connect(url, token);
      const mic = await createLocalAudioTrack();
      await room.localParticipant.publishTrack(mic);
      attachToWaveform(new MediaStream([mic.mediaStreamTrack]), 'caller');
      startWaveform();
      roomRef.current = room;
      micRef.current = mic;
      setPhase('live');
    } catch (err) {
      cleanup();
      const msg = err instanceof Error ? err.message : 'Could not start the demo.';
      // A denied microphone is by far the most common failure, and the raw browser error is
      // meaningless to a garage owner.
      setError(/permission|denied|notallowed/i.test(msg) ? 'We need microphone access to run the demo — allow it and try again.' : msg);
      setPhase('failed');
    }
  }, [voice, cleanup, attachToWaveform, startWaveform]);

  const end = useCallback(() => { cleanup(); setPhase('ended'); }, [cleanup]);

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const idle = phase === 'idle' || phase === 'failed' || phase === 'ended';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white px-6 py-6 text-center">
      {/* phone + waveform */}
      <div className="relative mb-4 flex h-28 w-full max-w-sm items-center justify-center">
        {phase === 'live' ? (
          <canvas ref={canvasRef} className="h-24 w-full" aria-hidden="true" />
        ) : (
          <div className={`flex h-24 w-24 items-center justify-center rounded-full bg-brand-50 ring-1 ring-brand-200 ${phase === 'connecting' ? 'animate-pulse' : ''}`}>
            <svg className="h-10 w-10 text-brand-600" viewBox="0 0 20 20" fill="currentColor">
              <path d="M2 3.5A1.5 1.5 0 013.5 2h1.148a1.5 1.5 0 011.465 1.175l.716 3.223a1.5 1.5 0 01-1.052 1.767l-.933.267c-.41.117-.643.555-.48.95a11.542 11.542 0 006.254 6.254c.395.163.833-.07.95-.48l.267-.933a1.5 1.5 0 011.767-1.052l3.223.716A1.5 1.5 0 0118 15.352V16.5a1.5 1.5 0 01-1.5 1.5H15C7.82 18 2 12.18 2 5V3.5z" />
            </svg>
          </div>
        )}
      </div>

      {/* The modal band above the frame carries the name and the pitch; this line only reports
          what is happening right now. */}
      <p className="min-h-[2.5rem] max-w-sm text-sm leading-relaxed text-slate-600">
        {phase === 'live'
          ? 'Try booking your car in — she’ll take your details and read the registration back.'
          : phase === 'connecting'
            ? 'Connecting you to Leah…'
            : 'Pick a voice, then start the call.'}
      </p>

      {phase === 'live' ? <p className="mt-3 text-sm font-semibold tabular-nums text-brand-700">{mmss}</p> : null}

      {idle ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {VOICES.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setVoice(v.key)}
              className={
                v.key === voice
                  ? 'rounded-xl bg-brand-600 px-3.5 py-2 text-left text-xs font-semibold text-white shadow-sm'
                  : 'rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-left text-xs font-semibold text-slate-700 transition hover:bg-slate-50'
              }
            >
              <span className="block">{v.name}</span>
              <span className={v.key === voice ? 'block text-[10px] font-normal text-white/80' : 'block text-[10px] font-normal text-slate-500'}>
                {v.desc}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {error ? <p className="mt-4 max-w-sm rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-rose-200">{error}</p> : null}

      <div className="mt-6">
        {phase === 'live' ? (
          <button type="button" onClick={end} className="rounded-xl bg-rose-600 px-7 py-3.5 text-base font-semibold text-white shadow-lg transition hover:bg-rose-700">
            End the call
          </button>
        ) : (
          <button
            type="button"
            onClick={start}
            disabled={phase === 'connecting'}
            className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-7 py-3.5 text-base font-semibold text-white shadow-lg shadow-brand-600/30 transition hover:bg-brand-700 disabled:opacity-60"
          >
            {phase === 'connecting' ? 'Connecting…' : phase === 'ended' ? 'Call again' : phase === 'failed' ? 'Try again' : 'Start the call'}
          </button>
        )}
      </div>

      <p className="mt-5 text-[11px] text-slate-400">Demo only · no real booking is made · calls end after 5 minutes</p>
    </div>
  );
}
