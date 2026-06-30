'use client';

// Public, auth-bypassed `/demo` page. Hosts the talking-avatar product
// demo end-to-end: real portal layout (sidebar | navbar + main) with sample
// data, PLUS the LiveKit connection, the floating Tom avatar bubble and
// the suggested-question pills. Everything in one place — no iframe, no
// cross-window postMessage gymnastics.
//
// Sidebar markup is lifted verbatim from app/components/Sidebar.tsx, navbar
// from Navbar.tsx, screen JSX from each app/<route>/page.tsx.

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type {
  LocalAudioTrack,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  Room as RoomType,
} from 'livekit-client';
import { cn } from '../lib/utils';

type ScreenKey =
  | 'dashboard'
  | 'calls'
  | 'messages'
  | 'agent-configurations'
  | 'team'
  | 'integrations'
  | 'billing';

interface NavItem {
  key: ScreenKey;
  label: string;
  href: string;
  hasScreen: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard',            label: 'Dashboard',            href: '/dashboard',            hasScreen: true  },
  { key: 'calls',                label: 'Calls',                href: '/calls',                hasScreen: true  },
  { key: 'messages',             label: 'Messages',             href: '/messages',             hasScreen: false },
  { key: 'agent-configurations', label: 'Agent Configurations', href: '/agent-configurations', hasScreen: true  },
  { key: 'team',                 label: 'Team',                 href: '/team',                 hasScreen: false },
  { key: 'integrations',         label: 'Integrations',         href: '/integrations',         hasScreen: true  },
  { key: 'billing',              label: 'Billing',              href: '/billing',              hasScreen: true  },
];

const DEMO_BRANCH = { id: 'demo-receptionmate', name: 'ReceptionMate Demo' };

const SIGNED_IN_EMAIL  = 'demo@receptionmate.co.uk';
const SIGNED_IN_USERID = 'demo-user-id';

// Agent says "setup-wizard" / "pricing" / "bookings" — translate to the
// screens we actually render so it Just Works whichever vocabulary it picks.
const SCREEN_REMAP: Record<string, ScreenKey> = {
  'setup-wizard':         'agent-configurations',
  'agent-configurations': 'agent-configurations',
  'pricing':              'billing',
  'billing':              'billing',
  'bookings':             'calls',
  'calls':                'calls',
  'dashboard':            'dashboard',
  'integrations':         'integrations',
};

const SUGGESTED_QUESTIONS = [
  'Show me the dashboard',
  'How do bookings work?',
  'What does Assist cost?',
  'Walk me through agent configurations',
  'Show me the calls page',
  'Sign me up',
];

type AgentConfigTab =
  | 'company'
  | 'hours'
  | 'identity'
  | 'smart'
  | 'rules'
  | 'bookings'
  | 'training'
  | 'notifications'
  | 'integrations'
  | 'routing';

export default function DemoPage() {
  const [screen, setScreen] = useState<ScreenKey>('dashboard');
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'failed'>('connecting');
  const [micOn, setMicOn] = useState(true);
  const [avatarReady, setAvatarReady] = useState(false);
  const [pulsingBtn, setPulsingBtn] = useState<string | null>(null);
  const [agentConfigTab, setAgentConfigTab] = useState<AgentConfigTab>('identity');
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);

  const videoRef    = useRef<HTMLVideoElement | null>(null);
  const roomRef     = useRef<RoomType | null>(null);
  const micTrackRef = useRef<LocalAudioTrack | null>(null);

  // Highlight a [data-tour=...] element with a brand-coloured pulse.
  const highlightTarget = useCallback((target: string) => {
    const el = document.querySelector(`[data-tour="${target}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    (el as HTMLElement).classList.remove('demo-tour-highlight');
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    (el as HTMLElement).offsetWidth;
    (el as HTMLElement).classList.add('demo-tour-highlight');
    window.setTimeout(() => (el as HTMLElement).classList.remove('demo-tour-highlight'), 4000);
  }, []);

  // LiveKit connection — runs once on mount.
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const lk = await import('livekit-client');
        const { Room, RoomEvent, Track, createLocalAudioTrack } = lk;

        const tokenRes = await fetch('/api/livekit/demo-token', { method: 'POST' });
        if (!tokenRes.ok) throw new Error('Failed to mint LiveKit token');
        const { token, url } = await tokenRes.json();

        const room = new Room();

        room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, _p: RemoteParticipant) => {
          if (track.kind === Track.Kind.Video && videoRef.current) {
            track.attach(videoRef.current);
            if (mounted) setAvatarReady(true);
          } else if (track.kind === Track.Kind.Audio) {
            const audio = document.createElement('audio');
            audio.autoplay = true;
            track.attach(audio);
            document.body.appendChild(audio);
          }
        });

        room.on(RoomEvent.DataReceived, (payload, _p, _k, topic) => {
          if (topic !== 'ReceptionMateUI') return;
          try {
            const event = JSON.parse(new TextDecoder().decode(payload));
            if (event.type === 'show' && typeof event.screen === 'string') {
              const next = SCREEN_REMAP[event.screen] ?? null;
              if (next && mounted) setScreen(next);
            } else if (event.type === 'highlight' && typeof event.target === 'string') {
              highlightTarget(event.target);
            } else if (event.type === 'navigate' && typeof event.to === 'string') {
              window.location.href = event.to;
            } else if (event.type === 'show_config_tab' && typeof event.tab === 'string') {
              const valid = ['company','hours','identity','smart','rules','bookings','training','notifications','integrations','routing'];
              if (mounted && valid.includes(event.tab)) {
                setScreen('agent-configurations');
                setAgentConfigTab(event.tab as AgentConfigTab);
              }
            } else if (event.type === 'show_call' && typeof event.callId === 'string') {
              if (mounted) {
                setScreen('calls');
                setSelectedCallId(event.callId);
              }
            }
          } catch (_) {}
        });

        await room.connect(url, token);
        const mic = await createLocalAudioTrack();
        await room.localParticipant.publishTrack(mic);

        roomRef.current = room;
        micTrackRef.current = mic;
        if (mounted) setStatus('connected');
      } catch (err) {
        console.error('[demo] LiveKit connect failed', err);
        if (mounted) setStatus('failed');
      }
    })();

    return () => {
      mounted = false;
      roomRef.current?.disconnect();
    };
  }, [highlightTarget]);

  const askTom = useCallback(async (question: string) => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ type: 'user_text', text: question })),
        { reliable: true, topic: 'user-text' },
      );
      setPulsingBtn(question);
      window.setTimeout(() => setPulsingBtn((p) => (p === question ? null : p)), 1500);
    } catch (err) {
      console.error('Failed to send user_text', err);
    }
  }, []);

  const toggleMic = useCallback(async () => {
    const mic = micTrackRef.current;
    if (!mic) return;
    const next = !micOn;
    setMicOn(next);
    await mic.mute(!next);
  }, [micOn]);

  return (
    <>
      <style jsx global>{`
        .demo-tour-highlight {
          position: relative;
          z-index: 1;
          animation: demo-pulse 1.2s ease-out 0s 3;
          border-radius: 1rem;
        }
        @keyframes demo-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(52, 38, 207, 0.55); }
          70%  { box-shadow: 0 0 0 14px rgba(52, 38, 207, 0); }
          100% { box-shadow: 0 0 0 0 rgba(52, 38, 207, 0); }
        }
      `}</style>

      {/* Real portal layout: Sidebar | Navbar + main */}
      <div className="flex min-h-screen bg-slate-50 text-slate-900">

        {/* Sidebar — lifted from Sidebar.tsx */}
        <aside className="flex w-64 flex-col border-r border-brand-700 bg-brand-600">
          <div className="flex items-center justify-center border-b border-white/10 px-4 py-6">
            <img
              src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
              alt="ReceptionMate"
              className="h-16 w-auto"
            />
          </div>
          <nav className="flex-1 space-y-1 px-3 py-4">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => item.hasScreen && setScreen(item.key)}
                className={cn(
                  'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors text-left',
                  screen === item.key
                    ? 'bg-white text-brand-700 shadow-sm'
                    : 'text-brand-100 hover:bg-white/10 hover:text-white',
                  !item.hasScreen && 'opacity-90 cursor-default',
                )}
              >
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="border-t border-white/10 px-3 py-4">
            <div className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-200">Help</div>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-brand-100 transition-colors hover:bg-white/10 hover:text-white text-left"
            >
              <span>Help &amp; Guides</span>
            </button>
          </div>
          <div className="border-t border-white/10 px-5 py-4 text-xs text-brand-200">
            © {new Date().getFullYear()} ReceptionMate
          </div>
        </aside>

        <div className="flex flex-1 flex-col">
          {/* Navbar */}
          <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
            <div className="flex flex-col">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Branch</span>
              <div className="relative mt-1 w-64">
                <button
                  type="button"
                  onClick={() => setBranchDropdownOpen(!branchDropdownOpen)}
                  className="flex w-full items-center justify-between rounded-md border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-900 transition-colors hover:border-slate-400"
                >
                  <span className="truncate">{DEMO_BRANCH.name}</span>
                  <svg className={cn('h-4 w-4 text-slate-400 transition-transform', branchDropdownOpen && 'rotate-180')} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
                  </svg>
                </button>
                {branchDropdownOpen && (
                  <div className="absolute z-50 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-lg ring-1 ring-slate-900/5">
                    <div className="py-1">
                      <button
                        type="button"
                        onClick={() => setBranchDropdownOpen(false)}
                        className="w-full bg-brand-50 px-3 py-2 text-left text-sm font-semibold text-brand-700"
                      >
                        {DEMO_BRANCH.name}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <span className="mt-1 text-[11px] text-slate-500">
                Garage ID: <span className="font-mono break-all">{DEMO_BRANCH.id}</span>
              </span>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-slate-500">Signed in</p>
                <p className="text-sm font-semibold text-slate-900">{SIGNED_IN_EMAIL}</p>
                <p className="text-[11px] text-slate-500">User ID: <span className="font-mono break-all">{SIGNED_IN_USERID}</span></p>
              </div>
              <button type="button" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-slate-400 hover:bg-slate-50">
                Log out
              </button>
            </div>
          </header>

          {/* Main, with bottom padding so the floating question bar doesn't
              cover the last page row. */}
          <main className="flex-1 overflow-y-auto p-6 pb-32">
            {screen === 'dashboard'            && <DashboardScreen />}
            {screen === 'calls'                && <CallsScreen selectedCallId={selectedCallId} onSelectCall={setSelectedCallId} />}
            {screen === 'agent-configurations' && <AgentConfigsScreen activeTab={agentConfigTab} onTabChange={setAgentConfigTab} />}
            {screen === 'integrations'         && <IntegrationsScreen />}
            {screen === 'billing'              && <BillingScreen />}
            {(['messages', 'team'] as ScreenKey[]).includes(screen) && <StubScreen label={NAV_ITEMS.find((n) => n.key === screen)!.label} />}
          </main>
        </div>
      </div>

      {/* ============== Floating Tom avatar bubble ============== */}
      <div
        className="fixed z-50"
        style={{
          bottom: '6.5rem',
          right: '1.5rem',
          width: '14rem',
          height: '14rem',
          borderRadius: '9999px',
          overflow: 'hidden',
          background: '#0f172a',
          boxShadow: '0 30px 60px -12px rgba(0,0,0,0.55)',
          outline: '5px solid #fff',
          outlineOffset: '-5px',
        }}
      >
        <video ref={videoRef} playsInline autoPlay className="h-full w-full object-cover" />
        {!avatarReady && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10">
              <svg className="h-5 w-5 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <circle cx="12" cy="8" r="4"/>
                <path d="M4 20a8 8 0 0116 0"/>
              </svg>
            </div>
            <p className="mt-2 text-[10px] text-white/70">{status === 'failed' ? 'Connection failed' : 'Connecting…'}</p>
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-3 text-xs text-white">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          Tom
        </div>
      </div>

      {/* ============== Floating status / mic pill (top-right) ============== */}
      <div className="pointer-events-none fixed right-4 top-4 z-40 flex justify-end">
        <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-xl">
          <span className={cn(
            'inline-block h-2 w-2 rounded-full',
            status === 'connected' && 'bg-emerald-400',
            status === 'connecting' && 'bg-amber-400 animate-pulse',
            status === 'failed' && 'bg-rose-500',
          )} />
          <span>{status === 'connected' ? 'Connected' : status === 'failed' ? 'Connection failed' : 'Connecting…'}</span>
          <button
            type="button"
            onClick={toggleMic}
            className={cn(
              'ml-1 inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors',
              micOn ? 'bg-white/10 hover:bg-white/20' : 'bg-rose-500/30 hover:bg-rose-500/40',
            )}
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/>
            </svg>
            {micOn ? 'Mic on' : 'Mic off'}
          </button>
        </div>
      </div>

      {/* ============== Floating suggested-question bar (bottom-centre) ============== */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4 sm:px-6">
        <div className="pointer-events-auto flex max-w-5xl flex-wrap items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-white shadow-2xl ring-1 ring-white/10">
          <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-brand-200">Ask Tom</span>
          {SUGGESTED_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => askTom(q)}
              disabled={status !== 'connected'}
              className={cn(
                'rounded-full border px-3.5 py-1.5 text-xs font-semibold transition shadow-sm',
                pulsingBtn === q
                  ? 'border-emerald-400 bg-emerald-500/20 text-emerald-300'
                  : 'border-white/15 bg-white/10 text-white hover:border-white/40 hover:bg-white/20',
                status !== 'connected' && 'opacity-50 cursor-not-allowed',
              )}
            >
              {pulsingBtn === q ? '✓ Asked Tom' : `“${q}”`}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/* ============================================================
 * Screens — JSX from app/<route>/page.tsx with sample data.
 * ============================================================ */

function DashboardScreen() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-500">Monitor call performance, booking conversion, and sentiment at a glance.</p>
        </div>
        <div className="flex flex-wrap items-end gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col text-sm">
            <label className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Start date</label>
            <div className="rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm">17 May 2026</div>
          </div>
          <div className="flex flex-col text-sm">
            <label className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">End date</label>
            <div className="rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm">17 Jun 2026</div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-700">Today</button>
            <button type="button" className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-700">Last 7 days</button>
            <button type="button" className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-700">Last 30 days</button>
          </div>
          <button type="button" className="rounded-lg border border-emerald-600 bg-emerald-600 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white shadow-sm">Download confirmed bookings CSV</button>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-3xl bg-brand-600 px-8 py-10 shadow-lg shadow-brand-600/20" data-tour="captured-revenue">
        <div className="absolute -top-24 -right-24 h-48 w-48 rounded-full bg-brand-400/30 blur-3xl" aria-hidden />
        <div className="absolute -bottom-24 -left-24 h-48 w-48 rounded-full bg-fuchsia-500/20 blur-3xl" aria-hidden />
        <div className="relative grid gap-6 sm:grid-cols-2 sm:items-center">
          <div className="space-y-3">
            <span className="text-xs font-semibold uppercase tracking-[0.35em] text-brand-100">Captured Revenue</span>
            <div className="text-5xl font-semibold text-white">£12,840</div>
            <p className="mt-2 max-w-lg text-sm text-brand-100">Total value of confirmed bookings within the selected window.</p>
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-white/15 bg-white/10 px-7 py-7 text-left backdrop-blur-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.25em] text-brand-100">Confirmed bookings</div>
            <div className="text-4xl font-semibold text-white">53</div>
            <p className="max-w-sm text-sm text-brand-100/90">Count of calls tagged as confirmed bookings during this window, directly driving captured revenue.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Total calls</div>
          <div className="mt-3 text-3xl font-semibold text-slate-900">187</div>
          <p className="mt-2 text-xs text-slate-500">All calls captured within the selected date range.</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Total duration</div>
          <div className="mt-3 text-3xl font-semibold text-slate-900">8h 22m</div>
          <p className="mt-2 text-xs text-slate-500">Combined call time for all calls in this period.</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Top call tag</div>
          <div className="mt-3 text-3xl font-semibold text-slate-900">MOT booking</div>
          <p className="mt-2 text-xs text-slate-500">Most frequent call classification in the selected window.</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3" data-tour="dashboard-charts">
        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Call type distribution</h2>
            <span className="text-xs uppercase tracking-wide text-slate-500">By tag</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">Tags show the purpose of each call and highlight where your team is spending time.</p>
          <div className="mt-6 flex flex-col items-center gap-6 lg:flex-row lg:items-stretch">
            <div className="flex justify-center lg:w-1/2">
              <div
                className="relative h-44 w-44 rounded-full border border-slate-200 bg-slate-50 shadow-sm"
                style={{ backgroundImage: 'conic-gradient(#10b981 0% 28%, #f59e0b 28% 46%, #6366f1 46% 64%, #94a3b8 64% 84%, #cbd5e1 84% 100%)' }}
              >
                <div className="absolute inset-7 flex flex-col items-center justify-center rounded-full border border-slate-200 bg-white text-slate-900 shadow-inner shadow-black/40">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">Total calls</span>
                  <span className="mt-0.5 text-2xl font-semibold text-slate-900">187</span>
                </div>
              </div>
            </div>
            <div className="flex w-full flex-1 flex-col gap-2">
              {[
                { label: 'Confirmed booking', count: 53, percent: 28, colour: '#10b981' },
                { label: 'Quote',             count: 34, percent: 18, colour: '#f59e0b' },
                { label: 'Update',            count: 34, percent: 18, colour: '#6366f1' },
                { label: 'Enquiry',           count: 37, percent: 20, colour: '#94a3b8' },
                { label: 'Other',             count: 29, percent: 16, colour: '#cbd5e1' },
              ].map((t) => (
                <div key={t.label} className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="h-3 w-3 rounded-full" style={{ backgroundColor: t.colour }} aria-hidden />
                    <span className="text-slate-900">{t.label}</span>
                  </div>
                  <span className="text-xs text-slate-700">{t.count} • {t.percent}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Daily call volume</h2>
            <span className="text-xs uppercase tracking-wide text-slate-500">Trend</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">Track demand patterns to understand staffing needs and campaign impact.</p>
          <div className="mt-6 flex items-end gap-3 overflow-x-auto pb-2">
            {[
              { d: '11 Jun', n: 5  },
              { d: '12 Jun', n: 9  },
              { d: '13 Jun', n: 4  },
              { d: '14 Jun', n: 12 },
              { d: '15 Jun', n: 14 },
              { d: '16 Jun', n: 11 },
              { d: '17 Jun', n: 14 },
            ].map((b) => {
              const h = Math.max(6, (b.n / 14) * 100);
              return (
                <div key={b.d} className="flex w-10 flex-col items-center text-xs text-slate-500">
                  <div className="flex h-40 w-full items-end justify-center overflow-hidden rounded-full bg-slate-100">
                    <div className="w-full rounded-full bg-gradient-to-t from-sky-500 via-sky-400 to-sky-200 shadow-lg shadow-sky-900/50" style={{ height: `${h}%` }} />
                  </div>
                  <span className="mt-2 text-[10px] uppercase tracking-wide text-slate-500">{b.d}</span>
                  <span className="text-[11px] text-slate-700">{b.n}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Confirmed booking categories</h2>
            <span className="text-xs uppercase tracking-wide text-slate-500">Set customer info</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">Breakdown of confirmed bookings that hit the customer info webhook, grouped by service type.</p>
          <div className="mt-6 flex flex-col items-center gap-6 lg:flex-row lg:items-stretch">
            <div className="flex justify-center lg:w-1/2">
              <div
                className="relative h-36 w-36 rounded-full border border-slate-200 bg-slate-50 shadow-sm"
                style={{ backgroundImage: 'conic-gradient(#10b981 0% 38%, #6366f1 38% 60%, #f59e0b 60% 80%, #ef4444 80% 100%)' }}
              >
                <div className="absolute inset-5 flex flex-col items-center justify-center rounded-full border border-slate-200 bg-white text-slate-900 shadow-inner shadow-black/40">
                  <span className="text-[9px] uppercase tracking-[0.35em] text-slate-500">Confirmed</span>
                  <span className="mt-0.5 text-2xl font-semibold text-slate-900">53</span>
                </div>
              </div>
            </div>
            <div className="flex flex-1 flex-col gap-2">
              {[
                { label: 'MOT',        count: 20, percent: 38, colour: '#10b981' },
                { label: 'Service',    count: 12, percent: 23, colour: '#6366f1' },
                { label: 'Diagnostic', count: 11, percent: 21, colour: '#f59e0b' },
                { label: 'Repair',     count: 10, percent: 18, colour: '#ef4444' },
              ].map((e) => (
                <div key={e.label} className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="h-3 w-3 rounded-full" style={{ backgroundColor: e.colour }} aria-hidden />
                    <span className="text-slate-900">{e.label}</span>
                  </div>
                  <span className="text-xs text-slate-700">{e.count} • {e.percent}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-slate-900">Tag spotlight</h2>
        <p className="mt-1 text-sm text-slate-500">Quick overview of how often each tag is used. Use this to prioritise scripts and team training.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          {[
            { label: 'Confirmed booking', count: 53, style: 'bg-emerald-200/70 text-emerald-900' },
            { label: 'Quote',             count: 34, style: 'bg-amber-200/70 text-amber-900' },
            { label: 'Update',            count: 34, style: 'bg-indigo-200/70 text-indigo-900' },
            { label: 'Enquiry',           count: 37, style: 'bg-sky-200/70 text-sky-900' },
            { label: 'Other',             count: 29, style: 'bg-slate-200/80 text-slate-800' },
          ].map((t) => (
            <span key={t.label} className={cn('inline-flex min-w-[140px] items-center justify-between gap-2 rounded-full px-4 py-2 text-sm font-medium shadow shadow-black/20', t.style)}>
              <span>{t.label}</span>
              <span className="text-sm font-semibold">{t.count}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

interface SampleCall {
  id: string;
  caller: string;
  from: string;
  dt: string;
  tag: string;
  summary: string;
  rating: number;
  duration: string;
  transcript: { speaker: 'Leah' | 'Caller'; text: string }[];
  vehicle?: string;
  service?: string;
  bookedFor?: string;
}

const SAMPLE_CALLS: SampleCall[] = [
  {
    id: 'maria-davies-1432',
    caller: 'Maria Davies', from: '07700 900123', dt: '17 Jun 2026 · 14:32',
    tag: 'Confirmed booking',
    summary: 'MOT booking, Vauxhall Astra AB12 CDE. Booked for Mon 22 Jun.',
    rating: 5, duration: '1m 38s',
    vehicle: 'Vauxhall Astra · AB12 CDE', service: 'MOT', bookedFor: 'Mon 22 Jun · 14:00',
    transcript: [
      { speaker: 'Leah',   text: 'Hi, Demo Auto Centre — this is Leah, how can I help?' },
      { speaker: 'Caller', text: 'Hi, can I book an MOT please?' },
      { speaker: 'Leah',   text: 'Of course. Can I take the registration?' },
      { speaker: 'Caller', text: 'Yeah, AB12 CDE.' },
      { speaker: 'Leah',   text: 'Brilliant, a Vauxhall Astra. We\'ve got Monday at 2pm, would that work?' },
      { speaker: 'Caller', text: 'Yeah Monday 2 is great.' },
      { speaker: 'Leah',   text: 'Lovely. Can I just take a name and number to confirm?' },
      { speaker: 'Caller', text: 'Maria Davies, 07700 900123.' },
      { speaker: 'Leah',   text: 'Booked in. You\'ll get a text confirmation shortly. Thanks Maria!' },
    ],
  },
  {
    id: 'anonymous-1355',
    caller: 'Anonymous', from: '+44 (withheld)', dt: '17 Jun 2026 · 13:55',
    tag: 'Quote',
    summary: 'Clutch replacement quote — Astra 1.4 petrol.',
    rating: 4, duration: '2m 12s',
    vehicle: 'Vauxhall Astra 1.4', service: 'Clutch replacement (quote)',
    transcript: [
      { speaker: 'Leah',   text: 'Hi, Demo Auto Centre — Leah speaking, how can I help?' },
      { speaker: 'Caller', text: 'How much is a clutch replacement?' },
      { speaker: 'Leah',   text: 'Depends on the car — what model are we looking at?' },
      { speaker: 'Caller', text: 'Vauxhall Astra, 1.4 petrol, 2018.' },
      { speaker: 'Leah',   text: 'For that Astra you\'re looking at around £680 including the parts. We\'d need it for a day. Want me to get you booked in?' },
      { speaker: 'Caller', text: 'I\'ll have a think and call back.' },
    ],
  },
  {
    id: 'dave-allen-1218',
    caller: 'Dave Allen', from: '07700 901221', dt: '17 Jun 2026 · 12:18',
    tag: 'Update',
    summary: 'Running ~20 mins late for existing booking.',
    rating: 5, duration: '0m 32s',
    transcript: [
      { speaker: 'Leah',   text: 'Hi, Demo Auto Centre — Leah here, how can I help?' },
      { speaker: 'Caller', text: 'Hi, I\'ve got a booking at 1, just letting you know I\'ll be 20 minutes late.' },
      { speaker: 'Leah',   text: 'No problem, I\'ll let the team know. Can I take your name?' },
      { speaker: 'Caller', text: 'Dave Allen.' },
      { speaker: 'Leah',   text: 'Cheers Dave, see you shortly.' },
    ],
  },
  {
    id: 'liz-reynolds-1102',
    caller: 'Liz Reynolds', from: '07700 904455', dt: '17 Jun 2026 · 11:02',
    tag: 'Confirmed booking',
    summary: 'Brake check, BMW 320d EF34 GHJ. Booked Thu 25 Jun 11:00.',
    rating: 5, duration: '1m 44s',
    vehicle: 'BMW 320d · EF34 GHJ', service: 'Brake check', bookedFor: 'Thu 25 Jun · 11:00',
    transcript: [
      { speaker: 'Leah',   text: 'Hi, Demo Auto Centre — Leah speaking.' },
      { speaker: 'Caller', text: 'My brakes are squeaking, can I get them looked at?' },
      { speaker: 'Leah',   text: 'Absolutely. Reg please?' },
      { speaker: 'Caller', text: 'EF34 GHJ.' },
      { speaker: 'Leah',   text: 'BMW 320d — I can fit you in Thursday at 11am.' },
      { speaker: 'Caller', text: 'Perfect.' },
    ],
  },
  {
    id: 'andy-marshall-1647',
    caller: 'Andy Marshall', from: '07700 902112', dt: '16 Jun 2026 · 16:47',
    tag: 'Confirmed booking',
    summary: 'Tyres x4, Audi Q5 KL56 MNP. Booked Fri 26 Jun 15:30.',
    rating: 5, duration: '2m 03s',
    vehicle: 'Audi Q5 · KL56 MNP', service: '4 × tyres', bookedFor: 'Fri 26 Jun · 15:30',
    transcript: [
      { speaker: 'Leah',   text: 'Hi, Demo Auto Centre, Leah speaking.' },
      { speaker: 'Caller', text: 'I need four new tyres for an Audi Q5.' },
      { speaker: 'Leah',   text: 'No problem. Reg?' },
      { speaker: 'Caller', text: 'KL56 MNP.' },
      { speaker: 'Leah',   text: 'I\'ve got you down for Friday at 3:30, that work?' },
      { speaker: 'Caller', text: 'Yeah great.' },
    ],
  },
];

function CallsScreen({ selectedCallId, onSelectCall }: { selectedCallId: string | null; onSelectCall: (id: string | null) => void }) {
  const selected = SAMPLE_CALLS.find((c) => c.id === selectedCallId) ?? null;

  return (
    <div className="space-y-6" data-tour="calls-page">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">Call Activity</h1>
        <p className="text-sm text-slate-500">Monitor interactions from your ReceptionMate AI voice agent.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-tour="calls-kpi">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Total calls</div>
          <div className="mt-3 text-3xl font-semibold text-slate-900">187</div>
          <p className="mt-1 text-xs text-slate-500">In the selected filter</p>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-emerald-700">Confirmed bookings</div>
          <div className="mt-3 text-3xl font-semibold text-emerald-700">53</div>
          <p className="mt-1 text-xs text-slate-500">Calls that captured a booking</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Avg duration</div>
          <div className="mt-3 text-3xl font-semibold text-slate-900">2m 41s</div>
          <p className="mt-1 text-xs text-slate-500">Per call</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Total time</div>
          <div className="mt-3 text-3xl font-semibold text-slate-900">8h 22m</div>
          <p className="mt-1 text-xs text-slate-500">Combined call time</p>
        </div>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-900/5">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Recent calls</h2>
            <p className="text-xs text-slate-500">Click a call to view the transcript.</p>
          </div>
          <span className="hidden rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-200 sm:inline-flex">187 calls</span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-5 py-2.5">Caller</th>
              <th className="px-5 py-2.5">From number</th>
              <th className="px-5 py-2.5">Date &amp; time</th>
              <th className="px-5 py-2.5">Tag</th>
              <th className="px-5 py-2.5">Summary</th>
              <th className="px-5 py-2.5">Rating</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {SAMPLE_CALLS.map((c) => (
              <tr
                key={c.id}
                className={cn('cursor-pointer transition-colors', selectedCallId === c.id ? 'bg-brand-50' : 'hover:bg-slate-50')}
                onClick={() => onSelectCall(selectedCallId === c.id ? null : c.id)}
              >
                <td className="px-5 py-3 font-medium text-slate-900">{c.caller}</td>
                <td className="px-5 py-3 text-slate-700">{c.from}</td>
                <td className="px-5 py-3 text-slate-700">{c.dt}</td>
                <td className="px-5 py-3">
                  <span className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                    c.tag === 'Confirmed booking' ? 'bg-emerald-100 text-emerald-700' :
                    c.tag === 'Quote'             ? 'bg-amber-100 text-amber-700' :
                                                    'bg-slate-100 text-slate-600',
                  )}>{c.tag}</span>
                </td>
                <td className="px-5 py-3 text-xs text-slate-600 max-w-xs truncate">{c.summary}</td>
                <td className="px-5 py-3 text-amber-500">{'★'.repeat(c.rating)}<span className="text-slate-200">{'★'.repeat(5 - c.rating)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Transcript drawer — appears below the table when a row is selected. */}
      {selected && (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm" data-tour="calls-transcript">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">{selected.caller} · {selected.dt}</h2>
              <p className="text-xs text-slate-500">{selected.tag} · {selected.duration}{selected.vehicle ? ` · ${selected.vehicle}` : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700">
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Play recording
              </button>
              <button type="button" onClick={() => onSelectCall(null)} className="rounded-md text-slate-400 hover:text-slate-600 px-2">✕</button>
            </div>
          </div>
          {(selected.vehicle || selected.service || selected.bookedFor) && (
            <div className="grid grid-cols-3 gap-3 border-b border-slate-100 bg-slate-50 px-5 py-4 text-sm">
              {selected.vehicle && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Vehicle</p>
                  <p className="mt-0.5 font-medium text-slate-900">{selected.vehicle}</p>
                </div>
              )}
              {selected.service && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Service</p>
                  <p className="mt-0.5 font-medium text-slate-900">{selected.service}</p>
                </div>
              )}
              {selected.bookedFor && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600">Booked for</p>
                  <p className="mt-0.5 font-medium text-emerald-900">{selected.bookedFor}</p>
                </div>
              )}
            </div>
          )}
          <ol className="space-y-2.5 p-5 text-sm">
            {selected.transcript.map((line, i) => (
              <li
                key={i}
                className={cn(
                  'rounded-xl px-4 py-2.5',
                  line.speaker === 'Leah' ? 'border border-brand-100 bg-brand-50' : 'bg-white ring-1 ring-slate-200',
                )}
              >
                <p className={cn(
                  'text-[10px] font-semibold uppercase tracking-wider',
                  line.speaker === 'Leah' ? 'text-brand-700' : 'text-slate-500',
                )}>{line.speaker}</p>
                <p className="text-slate-800">{line.text}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

const AGENT_CONFIG_TABS: { key: AgentConfigTab; title: string; desc: string }[] = [
  { key: 'company',       title: 'Company information',        desc: 'Branch name, contact, address' },
  { key: 'hours',         title: 'Opening hours',              desc: 'When the agent answers' },
  { key: 'identity',      title: 'Identity, voice & greeting', desc: 'How the agent sounds + first line + pronunciations' },
  { key: 'smart',         title: 'Smart questions & FAQs',     desc: 'What to ask + common Q&A' },
  { key: 'rules',         title: 'Rules',                      desc: 'Custom rules the agent must follow' },
  { key: 'bookings',      title: 'Bookings & transfers',       desc: 'Booking behavior + where to send calls' },
  { key: 'training',      title: 'Training',                   desc: 'Teach the agent about you' },
  { key: 'notifications', title: 'Notifications',              desc: 'Who gets emailed after a call' },
  { key: 'integrations',  title: 'Integrations',               desc: 'HubSpot' },
  { key: 'routing',       title: 'Routing',                    desc: 'Agent assignment' },
];

function AgentConfigsScreen({ activeTab, onTabChange }: { activeTab: AgentConfigTab; onTabChange: (t: AgentConfigTab) => void }) {
  return (
    <div className="grid grid-cols-[300px_1fr] gap-6" data-tour="agent-configs">
      <aside className="space-y-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Agent Setup</p>
          <p className="mt-1 text-sm text-slate-500">Configure this garage&rsquo;s AI agent.<br/>Changes apply on next call.</p>
        </div>
        <nav className="space-y-1">
          {AGENT_CONFIG_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onTabChange(t.key)}
              className={cn(
                'block w-full rounded-xl px-4 py-3 text-left transition-colors',
                activeTab === t.key ? 'bg-brand-600 text-white shadow-sm' : 'bg-white text-slate-700 hover:bg-slate-100',
              )}
            >
              <p className={cn('text-sm font-semibold', activeTab === t.key ? 'text-white' : 'text-slate-900')}>{t.title}</p>
              <p className={cn('mt-0.5 text-xs', activeTab === t.key ? 'text-brand-100' : 'text-slate-500')}>{t.desc}</p>
            </button>
          ))}
        </nav>
      </aside>

      <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" data-tour={`agent-${activeTab}`}>
        {activeTab === 'company'       && <CompanyTabContent />}
        {activeTab === 'hours'         && <HoursTabContent />}
        {activeTab === 'identity'      && <IdentityTabContent />}
        {activeTab === 'smart'         && <SmartQuestionsTabContent />}
        {activeTab === 'rules'         && <RulesTabContent />}
        {activeTab === 'bookings'      && <BookingsTabContent />}
        {activeTab === 'training'      && <TrainingTabContent />}
        {activeTab === 'notifications' && <NotificationsTabContent />}
        {activeTab === 'integrations'  && <ConfigIntegrationsTabContent />}
        {activeTab === 'routing'       && <RoutingTabContent />}
      </div>
    </div>
  );
}

function CompanyTabContent() {
  return (
    <>
      <SectionHeader title="Company information" desc="The basics Leah uses to answer the phone — branch name, address, contact details." />
      <FormRow label="Branch name"><Input defaultValue="Demo Auto Centre" /></FormRow>
      <FormRow label="Trading address"><Input defaultValue="1 Sample Lane, Example Town, EX1 2DM" /></FormRow>
      <FormRow label="Reception phone"><Input defaultValue="01234 567 890" /></FormRow>
      <FormRow label="Contact email"><Input defaultValue="hello@demoautocentre.test" /></FormRow>
      <SaveBar />
    </>
  );
}

function HoursTabContent() {
  const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  return (
    <>
      <SectionHeader title="Opening hours" desc="Leah only books appointments inside these hours. Outside them, she takes a message and emails it across." />
      <div className="grid grid-cols-[120px_1fr_1fr_auto] items-center gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Day</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Open</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Close</span>
        <span></span>
        {days.map((d, i) => {
          const closed = i === 6;
          return (
            <Fragment key={d}>
              <span className="text-sm font-medium text-slate-700">{d}</span>
              <Input defaultValue={closed ? '' : '08:00'} disabled={closed} />
              <Input defaultValue={closed ? '' : (i === 5 ? '13:00' : '17:30')} disabled={closed} />
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" defaultChecked={closed} className="rounded border-slate-300"/> Closed
              </label>
            </Fragment>
          );
        })}
      </div>
      <SaveBar />
    </>
  );
}

function IdentityTabContent() {
  return (
    <>
      <SectionHeader title="Identity, voice & greeting" desc="How the agent sounds, the first line they say, and the way they handle tricky words." />
      <FormRow label="Agent name"><Input defaultValue="Leah" /></FormRow>
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Voice</label>
        <div className="grid grid-cols-3 gap-3">
          {[
            { name: 'Tom',    desc: 'Friendly mid-thirties male, Northern', selected: true  },
            { name: 'Leah',   desc: 'Warm female, neutral British',         selected: false },
            { name: 'Sophie', desc: 'Bright female, professional',          selected: false },
            { name: 'Fraser', desc: 'Older male, calm and reassuring',      selected: false },
            { name: 'Gemma',  desc: 'Soft female, friendly Welsh lilt',     selected: false },
            { name: 'Isobel', desc: 'Clear female, Scottish',               selected: false },
          ].map((v) => (
            <button key={v.name} type="button" className={cn(
              'flex items-center gap-3 rounded-xl border-2 p-3 text-left',
              v.selected ? 'border-brand-600 bg-brand-50' : 'border-slate-200 bg-white hover:border-slate-300',
            )}>
              <span className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                v.selected ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600',
              )}>
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn('text-sm font-semibold', v.selected ? 'text-brand-900' : 'text-slate-900')}>{v.name}</p>
                <p className="text-[11px] text-slate-500">{v.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
      <FormRow label="Opening greeting"><Textarea defaultValue="Hi, Demo Auto Centre — this is Leah, how can I help?" /></FormRow>
      <FormRow label="Pronunciations" hint="One per line, format: word: phonetic"><Textarea defaultValue={'MOT: em-oh-tee\nDPF: dee-pee-eff'} mono /></FormRow>
      <SaveBar />
    </>
  );
}

function SmartQuestionsTabContent() {
  return (
    <>
      <SectionHeader title="Smart questions & FAQs" desc="Things Leah will ask every caller, plus answers to common questions. She'll pull these in automatically." />
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Always ask</label>
        <ul className="space-y-2">
          {['Vehicle registration', 'Make and model', 'Service required', 'Best contact number'].map((q) => (
            <li key={q} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
              <span>{q}</span>
              <button type="button" className="text-xs font-medium text-rose-600">Remove</button>
            </li>
          ))}
        </ul>
        <button type="button" className="mt-3 inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700">+ Add question</button>
      </div>
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">FAQs</label>
        <div className="space-y-2">
          {[
            { q: 'Do you do MOTs?',           a: 'Yes — class 4 and class 7. Same day if booked before 11am.' },
            { q: 'Do you have a courtesy car?', a: 'Yes, we have two — free with bookings over £200.' },
            { q: 'Where are you?',            a: 'Sample Lane, just off the main high street. Plenty of customer parking.' },
          ].map((f) => (
            <div key={f.q} className="rounded-lg border border-slate-200 bg-white p-3">
              <p className="text-sm font-semibold text-slate-900">{f.q}</p>
              <p className="mt-1 text-xs text-slate-600">{f.a}</p>
            </div>
          ))}
        </div>
      </div>
      <SaveBar />
    </>
  );
}

function RulesTabContent() {
  return (
    <>
      <SectionHeader title="Rules" desc="Hard constraints Leah must obey. She'll refuse anything that breaks these and explain why to the caller." />
      <div className="space-y-2">
        {[
          { r: 'Never book bookings within 24 hours',                on: true  },
          { r: 'Only book MOTs Monday–Friday before 4pm',           on: true  },
          { r: 'Refuse customers asking for cash discount',         on: false },
          { r: 'Always transfer pricing questions over £500 to me', on: true  },
        ].map((rule) => (
          <div key={rule.r} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <span className="text-slate-800">{rule.r}</span>
            <button type="button" className={cn(
              'inline-flex h-6 w-11 items-center rounded-full transition-colors',
              rule.on ? 'bg-brand-600' : 'bg-slate-300',
            )}>
              <span className={cn('inline-block h-5 w-5 rounded-full bg-white transition-transform', rule.on ? 'translate-x-5' : 'translate-x-0.5')}/>
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700">+ Add rule</button>
      <SaveBar />
    </>
  );
}

function BookingsTabContent() {
  return (
    <>
      <SectionHeader title="Bookings & transfers" desc="How Leah handles bookings — and when she puts callers through to a human." />
      <FormRow label="Booking lead time" hint="Leah won't book inside this window — gives you prep time."><Select options={['Same day','1–3 days','4–7 days','1–2 weeks','2+ weeks']} value="1–3 days" /></FormRow>
      <FormRow label="Where do bookings land?"><Select options={['Portal inbox only','Email + portal inbox','Email + diary integration']} value="Email + portal inbox" /></FormRow>
      <FormRow label="Transfer to a human when…" hint="Trigger phrases">
        <Textarea defaultValue={'asks for the manager\nsays complaint or refund\nasks about a recent invoice'} mono />
      </FormRow>
      <FormRow label="Transfer to"><Input defaultValue="07700 900 100 (workshop manager)" /></FormRow>
      <SaveBar />
    </>
  );
}

function TrainingTabContent() {
  return (
    <>
      <SectionHeader title="Training" desc="The more Leah knows about your shop, the more naturally she answers. Add documents, links, or just paste notes." />
      <div className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-8 text-center">
        <p className="text-sm font-semibold text-slate-700">Drop a PDF or DOCX here</p>
        <p className="mt-1 text-xs text-slate-500">Or paste a link · Max 10 MB per file</p>
        <button type="button" className="mt-3 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white">Choose file</button>
      </div>
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Currently trained on</label>
        <ul className="space-y-2">
          {[
            { name: 'Price list.pdf',         size: '142 KB', when: 'Updated 12 days ago' },
            { name: 'Service menu Q2 2026.docx', size: '38 KB', when: 'Updated 4 days ago' },
            { name: 'demoautocentre.test',    size: 'live',   when: 'Re-crawled nightly' },
          ].map((d) => (
            <li key={d.name} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <div>
                <p className="font-medium text-slate-900">{d.name}</p>
                <p className="text-[11px] text-slate-500">{d.size} · {d.when}</p>
              </div>
              <button type="button" className="text-xs font-medium text-rose-600">Remove</button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function NotificationsTabContent() {
  return (
    <>
      <SectionHeader title="Notifications" desc="Who gets emailed when Leah finishes a call, and what type of call triggers an email." />
      <FormRow label="Email recipients" hint="Comma separated"><Input defaultValue="manager@demoautocentre.test, hello@demoautocentre.test" /></FormRow>
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Email when…</label>
        <div className="space-y-1.5">
          {[
            { label: 'Confirmed booking', on: true },
            { label: 'Quote given',       on: true },
            { label: 'Caller transferred', on: true },
            { label: 'Caller hung up',    on: false },
            { label: 'Every single call', on: false },
          ].map((n) => (
            <label key={n.label} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <span className="text-slate-800">{n.label}</span>
              <input type="checkbox" defaultChecked={n.on} className="rounded border-slate-300"/>
            </label>
          ))}
        </div>
      </div>
      <SaveBar />
    </>
  );
}

function ConfigIntegrationsTabContent() {
  return (
    <>
      <SectionHeader title="Integrations" desc="Plug Leah into your tools so bookings sync straight into your diary." />
      <div className="grid grid-cols-2 gap-3">
        {[
          { n: 'Garage Hive', status: 'Not connected' },
          { n: 'Tyresoft',    status: 'Not connected' },
          { n: 'HubSpot',     status: 'Connected · since 12 May 2026', live: true },
        ].map((i) => (
          <div key={i.n} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-slate-900">{i.n}</p>
              {i.live ? (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Live</span>
              ) : (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">Off</span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">{i.status}</p>
            <button type="button" className={cn('mt-3 w-full rounded-md px-3 py-1.5 text-xs font-semibold', i.live ? 'bg-slate-100 text-slate-700' : 'bg-brand-600 text-white')}>
              {i.live ? 'Manage' : 'Connect'}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function RoutingTabContent() {
  return (
    <>
      <SectionHeader title="Routing" desc="Which agent answers when. Useful for multi-branch operators sharing a single number." />
      <FormRow label="Default agent"><Select options={['Leah (Assist)','Leah (Automate)','Tom']} value="Leah (Assist)" /></FormRow>
      <FormRow label="Out-of-hours agent"><Select options={['Same as default','Voicemail only','Forward to mobile']} value="Same as default" /></FormRow>
      <FormRow label="Forwarding number" hint="Used when 'Forward to mobile' is selected above"><Input defaultValue="07700 900 100" /></FormRow>
      <SaveBar />
    </>
  );
}

/* ===== Small primitives used by the config tabs ===== */
function SectionHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">{desc}</p>
    </div>
  );
}
function FormRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" {...props} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm disabled:bg-slate-100 disabled:text-slate-400" />;
}
function Textarea({ mono, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea rows={3} {...props} className={cn('w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm', mono && 'font-mono')} />;
}
function Select({ options, value }: { options: string[]; value: string }) {
  return (
    <select defaultValue={value} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm">
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
function SaveBar() {
  return (
    <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
      <button type="button" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">Discard</button>
      <button type="button" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm">Save changes</button>
    </div>
  );
}

function IntegrationsScreen() {
  const items = [
    { n: 'Garage Hive',    s: 'Connect',   ok: true,  badge: 'Supported',     bcolour: 'bg-emerald-100 text-emerald-700' },
    { n: 'Tyresoft',       s: 'Connect',   ok: true,  badge: 'Supported',     bcolour: 'bg-emerald-100 text-emerald-700' },
    { n: 'HubSpot',        s: 'Connect',   ok: true,  badge: 'Supported',     bcolour: 'bg-emerald-100 text-emerald-700' },
    { n: 'ProtechMS',      s: 'Notify me', ok: false, badge: 'Coming soon',   bcolour: 'bg-amber-100 text-amber-700' },
    { n: 'MAM Autowork',   s: 'Notify me', ok: false, badge: 'Roadmap',       bcolour: 'bg-slate-100 text-slate-600' },
    { n: 'Something else', s: 'Talk to us',ok: false, badge: 'Custom',        bcolour: 'bg-violet-100 text-violet-700' },
  ];
  return (
    <div className="space-y-6" data-tour="integrations">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Integrations</h1>
        <p className="mt-1 text-sm text-slate-500">Plug your booking system in to upgrade Assist to Automate.</p>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {items.map((i) => (
          <div key={i.n} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
                  <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                  <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
                </svg>
              </span>
              <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', i.bcolour)}>{i.badge}</span>
            </div>
            <p className="mt-3 font-semibold text-slate-900">{i.n}</p>
            <p className="mt-1 text-xs text-slate-500">Two-way sync · Leah writes bookings straight into the diary.</p>
            <button type="button" className={cn(
              'mt-4 w-full rounded-lg px-3 py-2 text-xs font-semibold shadow-sm',
              i.ok ? 'bg-brand-600 text-white' : 'border border-slate-300 text-slate-700',
            )}>{i.s}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function BillingScreen() {
  return (
    <div className="space-y-6" data-tour="billing">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Billing</h1>
        <p className="mt-1 text-sm text-slate-500">Your current bill, payment method and invoice history.</p>
      </div>
      <div className="grid grid-cols-[2fr_1fr] gap-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Assist · Active</span>
            <p className="text-xs text-slate-500">Due 16 July</p>
          </div>
          <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-slate-500">June 2026</p>
          <p className="mt-1 text-4xl font-semibold tracking-tight text-slate-900">£240<span className="text-xl text-slate-400">.00</span></p>
          <hr className="my-5 border-slate-100"/>
          <ul className="space-y-2 text-sm text-slate-700">
            <li className="flex justify-between"><span>Assist subscription</span><span className="font-medium">£200.00</span></li>
            <li className="flex justify-between"><span>Minutes used <span className="text-slate-400">(38 / 400 included)</span></span><span className="font-medium">£0.00</span></li>
            <li className="flex justify-between border-t border-slate-100 pt-2"><span>Subtotal</span><span className="font-medium">£200.00</span></li>
            <li className="flex justify-between"><span>VAT (20%)</span><span className="font-medium">£40.00</span></li>
            <li className="flex justify-between text-base font-bold text-slate-900"><span>Total</span><span>£240.00</span></li>
          </ul>
        </div>
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Payment method</p>
            <p className="mt-2 text-sm font-semibold text-slate-900">Direct Debit · ending 4421</p>
            <p className="mt-1 text-xs text-slate-500">Next collection: 16 July 2026</p>
            <button type="button" className="mt-3 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm">Update mandate</button>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Usage this month</p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: '9.5%' }}></div>
            </div>
            <p className="mt-2 text-xs text-slate-500">38 of 400 included minutes used. Overage: 25p / min.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StubScreen({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[400px] items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white">
      <div className="text-center">
        <p className="text-sm font-semibold text-slate-900">{label}</p>
        <p className="mt-1 text-xs text-slate-500">Not included in the demo — ask Tom to show another page.</p>
      </div>
    </div>
  );
}
