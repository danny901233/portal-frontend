'use client';

// One tap, no form. The link already tells us which garage this is, so asking the prospect to
// type a name or an email would be asking a known person to introduce themselves — which is
// exactly the friction that makes people close the tab.
//
// Desktop: press the button, allow the mic, talk.
// Mobile: a tel: link whose dial string carries their code as auto-DTMF, so the handset sends it
// and the prospect never sees a reference number. The webhook reads the tones and puts them on
// their own garage's agent; anything it cannot resolve falls back to the generic demo rather than
// a dead line.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalAudioTrack, RemoteTrack, Room as RoomType } from 'livekit-client';

type Phase = 'loading' | 'ready' | 'building' | 'connecting' | 'live' | 'ended' | 'failed' | 'gone';

// The prospect demo line. One number for everyone: the code in the dial string is what picks the
// garage, so this never needs to be per-prospect.
const DEMO_NUMBER = '+441708985485';

export default function TryClient({ slug }: { slug: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [name, setName] = useState('your garage');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  const roomRef = useRef<RoomType | null>(null);
  const micRef = useRef<LocalAudioTrack | null>(null);

  useEffect(() => {
    setIsMobile(/iphone|ipad|android/i.test(navigator.userAgent));
  }, []);

  // Who is this? Rendered before anything is pressed, so the page says their name immediately.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/public/demo-prospect/${encodeURIComponent(slug)}`);
        if (res.status === 404 || res.status === 410) {
          if (live) setPhase('gone');
          return;
        }
        if (!res.ok) throw new Error('lookup failed');
        const data = await res.json();
        if (!live) return;
        setName(data.spokenName || 'your garage');
        setCode(data.code || '');
        setPhase('ready');
      } catch {
        if (live) setPhase('ready'); // let them try anyway; the build call will say if it's dead
      }
    })();
    return () => {
      live = false;
    };
  }, [slug]);

  useEffect(() => {
    if (phase !== 'live') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const hangUp = useCallback(() => {
    try {
      micRef.current?.stop();
      roomRef.current?.disconnect();
    } catch {
      /* already gone */
    }
    micRef.current = null;
    roomRef.current = null;
    setPhase('ended');
  }, []);

  /**
   * Build their agent as the dialler opens, so it exists by the time the call connects.
   *
   * Without this the phone path was broken for every real prospect. The agent is built on first
   * use, and only the browser button did that — "Call and listen" is a plain tel: link, so a
   * prospect who tapped it first (the obvious thing to do, it is the primary button) reached a
   * prospect with no agent, and the webhook sent them to the generic demo. Every test call here
   * worked only because those agents had already been built by hand.
   *
   * Deliberately not awaited and deliberately not blocking the dial: the first config write is the
   * quick one and lands well inside the six seconds the dial string pauses before sending the
   * code. keepalive matters — the handset takes the page into the background the moment the
   * dialler opens, and without it the browser is free to cancel the request in flight.
   */
  const buildBeforeCalling = useCallback(() => {
    try {
      void fetch(`/api/public/demo-prospect/${encodeURIComponent(slug)}`, {
        method: 'POST',
        keepalive: true,
      });
    } catch {
      /* the call still goes through; the webhook falls back to the generic demo */
    }
  }, [slug]);

  const start = useCallback(async () => {
    setError('');
    setSeconds(0);
    try {
      // Built on first click rather than up front: most prospects never click, and this is also
      // the most persuasive few seconds on the page.
      setPhase('building');
      const built = await fetch(`/api/public/demo-prospect/${encodeURIComponent(slug)}`, { method: 'POST' });
      if (built.status === 410 || built.status === 404) {
        setPhase('gone');
        return;
      }
      if (!built.ok) throw new Error('We could not build your receptionist just now.');
      const info = await built.json();
      if (info.spokenName) setName(info.spokenName);
      if (info.code) setCode(info.code);

      setPhase('connecting');
      const { Room, RoomEvent, Track, createLocalAudioTrack } = await import('livekit-client');
      const res = await fetch('/api/livekit/demo-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospectSlug: slug, voice: 'leah' }),
      });
      if (res.status === 429) throw new Error('You have already tried this recently.');
      if (res.status === 503) throw new Error('All demo lines are busy — try again in a few minutes.');
      if (!res.ok) throw new Error('Could not start the call.');
      const { token: lkToken, url } = await res.json();

      const room = new Room();
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach() as HTMLAudioElement;
        el.autoplay = true;
        document.body.appendChild(el);
      });
      room.on(RoomEvent.Disconnected, () => setPhase('ended'));

      await room.connect(url, lkToken);
      const mic = await createLocalAudioTrack();
      await room.localParticipant.publishTrack(mic);
      roomRef.current = room;
      micRef.current = mic;
      setPhase('live');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('failed');
    }
  }, [slug]);

  // Commas are dialler pauses; %23 is '#'. The handset emits the tones itself once connected, so
  // the code never has to be read, remembered or typed.
  //
  // This is the prospect demo line, NOT the old 0333 demo number. The previous version of this
  // button pointed at that shared line, which has no <Gather> on it: the tones went nowhere and
  // every caller heard the GENERIC ReceptionMate demo while believing it was their own garage.
  // Without a code we send them to the browser instead of dialling a number that cannot identify
  // them.
  const telHref = code ? `tel:${DEMO_NUMBER},,,${code}%23` : '';

  if (phase === 'gone') {
    return (
      <main style={wrap}>
        <div style={card}>
          <h1 style={h1}>This link has expired</h1>
          <p style={p}>Demo links last 30 days. Reply to the email and we&apos;ll send a fresh one.</p>
        </div>
      </main>
    );
  }

  return (
    <main style={wrap}>
      <div style={card}>
        <p style={eyebrow}>Your AI receptionist</p>
        <h1 style={h1}>{name}</h1>

        {phase === 'loading' && <p style={p}>One moment…</p>}

        {(phase === 'ready' || phase === 'failed' || phase === 'ended') && (
          <>
            <p style={p}>
              This is what your customers hear when nobody can get to the phone. Ask it to book an
              MOT for next week.
            </p>
            {isMobile && telHref ? (
              <>
                <a href={telHref} onClick={buildBeforeCalling} style={btn}>Call and listen</a>
                <button onClick={start} style={linkBtn}>or talk in this browser</button>
              </>
            ) : (
              <button onClick={start} style={btn}>
                {isMobile ? 'Tap to talk to it' : 'Talk to it now'}
              </button>
            )}
            {phase === 'ended' && <p style={muted}>Call ended. Press again to go another round.</p>}
            {phase === 'failed' && <p style={errStyle}>{error}</p>}
          </>
        )}

        {phase === 'building' && (
          <p style={p}>
            Building {name}&apos;s receptionist — reading your opening hours and the jobs you do…
          </p>
        )}
        {phase === 'connecting' && <p style={p}>Connecting…</p>}

        {phase === 'live' && (
          <>
            <p style={p}>
              Live — {String(Math.floor(seconds / 60)).padStart(2, '0')}:
              {String(seconds % 60).padStart(2, '0')}
            </p>
            <button onClick={hangUp} style={{ ...btn, background: '#b42318' }}>End call</button>
          </>
        )}

        <p style={footer}>
          Nothing is really booked — it answers from a practice diary. ReceptionMate
        </p>
      </div>
    </main>
  );
}

// Inline styles: this page is linked from a cold email and opened once, so it has to render
// correctly on a first paint with no stylesheet race and no dependency on the portal's chrome.
const wrap: React.CSSProperties = {
  minHeight: '100dvh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  background: '#0f1024',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
};
const card: React.CSSProperties = {
  width: '100%',
  maxWidth: 460,
  background: '#fff',
  borderRadius: 18,
  padding: '36px 28px',
  textAlign: 'center',
  boxShadow: '0 20px 60px rgba(0,0,0,.35)',
};
const eyebrow: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  letterSpacing: '.09em',
  textTransform: 'uppercase',
  color: '#6470ed',
  fontWeight: 600,
};
const h1: React.CSSProperties = { margin: '8px 0 14px', fontSize: 26, lineHeight: 1.2, color: '#1d1a72' };
const p: React.CSSProperties = { margin: '0 0 20px', fontSize: 15, lineHeight: 1.55, color: '#44474f' };
const btn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '15px 20px',
  fontSize: 17,
  fontWeight: 600,
  color: '#fff',
  background: '#3426cf',
  border: 0,
  borderRadius: 11,
  cursor: 'pointer',
  textDecoration: 'none',
};
const linkBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 12,
  padding: 8,
  background: 'none',
  border: 0,
  color: '#6470ed',
  fontSize: 14,
  cursor: 'pointer',
  textDecoration: 'underline',
};
const muted: React.CSSProperties = { margin: '16px 0 0', fontSize: 13, color: '#6b7280' };
const errStyle: React.CSSProperties = { margin: '16px 0 0', fontSize: 14, color: '#b42318' };
const footer: React.CSSProperties = { margin: '26px 0 0', fontSize: 12, color: '#9aa0ab' };
