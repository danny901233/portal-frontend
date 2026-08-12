'use client';

// Public, auth-bypassed /demo — a "try it yourself" voice demo. The visitor clicks Start,
// grants mic access, and has a live conversation with the ReceptionMate demo receptionist
// (the self-hosted `demo-agent`, dispatched into the room by /api/livekit/demo-token).
// No integrations, no real booking — the agent makes that clear.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalAudioTrack, RemoteTrack, Room as RoomType } from 'livekit-client';
import { cn } from '../lib/utils';

type Phase = 'idle' | 'connecting' | 'live' | 'ended' | 'failed';
type Caption = { who: 'agent' | 'you'; text: string; id: string };

// Voices the demo agent can use (keys must match the backend allowlist + the agent's VOICES).
const VOICES: { key: string; name: string; desc: string }[] = [
  { key: 'leah', name: 'Leah', desc: 'Warm, neutral British' },
  { key: 'tom', name: 'Tom', desc: 'Friendly Northern male' },
  { key: 'sophie', name: 'Sophie', desc: 'Bright & professional' },
  { key: 'gemma', name: 'Gemma', desc: 'Soft Welsh lilt' },
  { key: 'isobel', name: 'Isobel', desc: 'Clear, Scottish' },
  { key: 'fraser', name: 'Fraser', desc: 'Calm, reassuring male' },
];

// Brand logo (same hosted asset the portal login/sidebar use).
const LOGO_URL = 'https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png';
// Where the "Sign up" CTA sends prospects — the marketing-site onboarding.
const SIGNUP_URL = 'https://receptionmate.co.uk/get-started/';

export default function DemoPage() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [voice, setVoice] = useState('leah');
  const [micOn, setMicOn] = useState(true);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const roomRef = useRef<RoomType | null>(null);
  const micRef = useRef<LocalAudioTrack | null>(null);
  const capBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (capBoxRef.current) capBoxRef.current.scrollTop = capBoxRef.current.scrollHeight;
  }, [captions]);

  const cleanup = useCallback(() => {
    try { roomRef.current?.disconnect(); } catch { /* noop */ }
    roomRef.current = null;
    micRef.current = null;
    document.querySelectorAll('audio[data-demo]').forEach((el) => el.remove());
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const start = useCallback(async () => {
    setPhase('connecting');
    setCaptions([]);
    try {
      const lk = await import('livekit-client');
      const { Room, RoomEvent, Track, createLocalAudioTrack } = lk;

      const res = await fetch('/api/livekit/demo-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice }),
      });
      if (!res.ok) throw new Error('Failed to start the demo');
      const { token, url } = await res.json();

      const room = new Room();

      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach() as HTMLAudioElement;
          el.autoplay = true;
          el.setAttribute('data-demo', '1');
          document.body.appendChild(el);
        }
      });

      // Live captions — best-effort; if the SDK shape differs it simply shows none.
      try {
        room.on(RoomEvent.TranscriptionReceived, (segments: unknown, participant: unknown) => {
          const segs = segments as { text?: string; final?: boolean; id?: string }[];
          const p = participant as { isLocal?: boolean } | undefined;
          const who: 'agent' | 'you' = p?.isLocal ? 'you' : 'agent';
          setCaptions((prev) => {
            const next = [...prev];
            for (const s of segs || []) {
              if (!s?.text) continue;
              const id = `${who}-${s.id ?? ''}`;
              const idx = next.findIndex((c) => c.id === id);
              if (idx >= 0) next[idx] = { who, text: s.text, id };
              else next.push({ who, text: s.text, id });
            }
            return next.slice(-40);
          });
        });
      } catch { /* transcription optional */ }

      room.on(RoomEvent.Disconnected, () => setPhase((prev) => (prev === 'live' ? 'ended' : prev)));

      await room.connect(url, token);
      const mic = await createLocalAudioTrack();
      await room.localParticipant.publishTrack(mic);
      roomRef.current = room;
      micRef.current = mic;
      setMicOn(true);
      setPhase('live');
    } catch (err) {
      console.error('[demo] start failed', err);
      cleanup();
      setPhase('failed');
    }
  }, [cleanup, voice]);

  const end = useCallback(() => {
    cleanup();
    setPhase('ended');
  }, [cleanup]);

  const toggleMic = useCallback(async () => {
    const mic = micRef.current;
    if (!mic) return;
    const next = !micOn;
    setMicOn(next);
    if (next) await mic.unmute();
    else await mic.mute();
  }, [micOn]);

  const live = phase === 'live';
  const selectedVoice = VOICES.find((v) => v.key === voice) ?? VOICES[0];
  const showPicker = phase === 'idle' || phase === 'ended' || phase === 'failed';

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-5 py-10 text-white">
      {/* brand ground: brand-600 + brand-400 glow + fuchsia glow (matches portal hero) */}
      <div
        className="absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(115% 90% at 88% -10%, rgba(100,112,237,.5), transparent 52%),' +
            'radial-gradient(90% 80% at 4% 116%, rgba(217,70,239,.28), transparent 55%),' +
            'linear-gradient(158deg,#211c8c,#3426cf 66%,#281eb0)',
        }}
      />

      <div className="w-full max-w-lg">
        {/* brand lockup — logo + Sign up CTA */}
        <div className="mb-8 flex items-center justify-between gap-3">
          <img src={LOGO_URL} alt="ReceptionMate" className="h-[5.5rem] w-auto" />
          <a
            href={SIGNUP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white ring-1 ring-white/25 transition hover:bg-white/20"
          >
            Sign up
          </a>
        </div>

        <div className="rounded-3xl bg-white/10 p-7 text-center shadow-2xl ring-1 ring-white/15 backdrop-blur-sm sm:p-9">
          {/* Leah avatar / live indicator */}
          <div className="relative mx-auto mb-5 h-24 w-24">
            <div
              className={cn(
                'grid h-24 w-24 place-items-center rounded-full bg-gradient-to-br from-[#efe9ff] to-[#cfc4ff] text-3xl font-bold text-brand-700',
                live && 'animate-[demoPulse_1.6s_ease-out_infinite]',
              )}
            >
              {selectedVoice.name.charAt(0)}
            </div>
            {live ? (
              <span className="absolute -bottom-0.5 -right-0.5 grid h-7 w-7 place-items-center rounded-full bg-emerald-500 ring-4 ring-[#2c22a8]">
                <span className="h-2.5 w-2.5 animate-ping rounded-full bg-white" />
              </span>
            ) : null}
          </div>

          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {live
              ? `${selectedVoice.name} is on the line`
              : phase === 'connecting'
                ? 'Connecting you…'
                : `Talk to ${selectedVoice.name}`}
          </h1>
          <p className="mx-auto mt-2 max-w-sm text-[15px] leading-relaxed text-brand-100/90">
            {live
              ? 'Book a car in like you would with your own garage. She’ll take your details, read your reg back, and “book” it — it’s a demo, so nothing’s really scheduled.'
              : 'Hear ReceptionMate’s AI receptionist for yourself. Pretend you’re calling a garage — she’ll answer, take a booking, and remind you it’s just a demo.'}
          </p>

          {/* voice picker (before the call) */}
          {showPicker ? (
            <div className="mt-6">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-brand-100/70">Choose a voice</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {VOICES.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => setVoice(v.key)}
                    className={cn(
                      'rounded-2xl px-3 py-2.5 text-left ring-1 transition',
                      v.key === voice
                        ? 'bg-white text-brand-700 ring-white shadow-lg'
                        : 'bg-white/10 text-white ring-white/20 hover:bg-white/20',
                    )}
                  >
                    <span className="block text-sm font-bold leading-tight">{v.name}</span>
                    <span className={cn('block text-[11px] leading-tight', v.key === voice ? 'text-brand-500' : 'text-brand-100/80')}>
                      {v.desc}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* live captions */}
          {live && captions.length > 0 ? (
            <div
              ref={capBoxRef}
              className="mt-5 max-h-44 space-y-2 overflow-y-auto rounded-2xl bg-black/20 p-3 text-left text-sm ring-1 ring-white/10"
            >
              {captions.map((c) => (
                <div key={c.id} className={cn('flex', c.who === 'you' ? 'justify-end' : 'justify-start')}>
                  <span
                    className={cn(
                      'inline-block max-w-[85%] rounded-2xl px-3 py-1.5 leading-snug',
                      c.who === 'you' ? 'bg-white text-slate-900' : 'bg-brand-500/70 text-white',
                    )}
                  >
                    {c.text}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {/* controls */}
          <div className="mt-7 flex items-center justify-center gap-3">
            {phase === 'idle' || phase === 'ended' || phase === 'failed' ? (
              <button
                type="button"
                onClick={start}
                className="rounded-full bg-white px-7 py-3 text-base font-bold text-brand-700 shadow-lg transition hover:bg-brand-50 active:scale-95"
              >
                {phase === 'ended' ? 'Start again' : phase === 'failed' ? 'Try again' : '📞  Start the demo'}
              </button>
            ) : null}

            {phase === 'connecting' ? (
              <div className="flex items-center gap-2 rounded-full bg-white/10 px-6 py-3 text-sm font-semibold">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-amber-300" />
                Connecting…
              </div>
            ) : null}

            {live ? (
              <>
                <button
                  type="button"
                  onClick={toggleMic}
                  className={cn(
                    'grid h-12 w-12 place-items-center rounded-full ring-1 transition active:scale-95',
                    micOn ? 'bg-white/10 ring-white/25 hover:bg-white/20' : 'bg-rose-500/80 ring-rose-300/40',
                  )}
                  aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
                    {!micOn ? <path strokeLinecap="round" d="M3 3l18 18" /> : null}
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={end}
                  className="rounded-full bg-rose-500 px-6 py-3 text-base font-bold text-white shadow-lg transition hover:bg-rose-600 active:scale-95"
                >
                  End call
                </button>
              </>
            ) : null}
          </div>

          {phase === 'failed' ? (
            <p className="mt-4 text-sm text-rose-200">
              Couldn’t start the demo — please allow microphone access and try again.
            </p>
          ) : null}
          {phase === 'ended' ? (
            <div className="mt-5 flex flex-col items-center gap-3">
              <p className="text-sm text-brand-100/90">Thanks for trying ReceptionMate. 👋</p>
              <a
                href={SIGNUP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full bg-white px-7 py-3 text-base font-bold text-brand-700 shadow-lg transition hover:bg-brand-50 active:scale-95"
              >
                Get started with ReceptionMate →
              </a>
            </div>
          ) : null}
        </div>

        <p className="mt-6 text-center text-xs text-brand-100/70">
          A live demo of ReceptionMate’s AI receptionist · no real booking is made · receptionmate.co.uk
        </p>
      </div>

      <style jsx global>{`
        @keyframes demoPulse {
          0% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.5); }
          70% { box-shadow: 0 0 0 22px rgba(255, 255, 255, 0); }
          100% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0); }
        }
      `}</style>
    </div>
  );
}
