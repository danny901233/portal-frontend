'use client';

// Floating help widget for the portal — opens a 3-tile menu (Live Chat,
// WhatsApp, Phone) modelled on the widget we deploy to garages' websites.
// Live Chat = AI assistant first, escalating to a real RM teammate when it
// gets stuck or the customer asks for a human.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchMySupportThread,
  markSupportThreadRead,
  sendSupportMessage,
  type SupportMessage,
} from '../lib/api';
import { getSessionToken } from '../lib/auth';

const POLL_MS_OPEN = 20_000;
const POLL_MS_CLOSED = 60_000;

// Real human teammate persona — used for escalated messages and the WhatsApp
// tile description. Replace avatarUrl with a real photo to swap the initial
// badge.
const SUPPORT_REP = {
  name: 'Dan',
  title: 'ReceptionMate team',
  avatarUrl: null as string | null,
};

// AI assistant persona — gives the bot a name + face so the chat feels like a
// teammate, not a noreply. Mirrors the pattern Jodie uses with "Elizma".
const AI_PERSONA = {
  name: 'Leah',
  title: 'ReceptionMate AI',
  tagline: 'Instant answers about your account, setup and billing.',
};

// Phone tile target — UK freephone for the team.
const SUPPORT_PHONE_DISPLAY = '0800 107 5988';
const SUPPORT_PHONE_DIAL = '+448001075988';

type View = 'menu' | 'connecting' | 'chat';

const CONNECTING_MS = 1500;

function relativeStatus(): string {
  const hour = new Date().getHours();
  if (hour >= 9 && hour < 18) return 'Active now';
  if (hour >= 18 && hour < 22) return 'Active recently';
  return 'Back tomorrow morning';
}

export default function SupportChatWidget() {
  const [authed, setAuthed] = useState(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('menu');
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Set once when Leah "joins" — keeps the announcement bubble visible for
  // the rest of the session even after she's replied.
  const [aiJoinedAt, setAiJoinedAt] = useState<Date | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  // Only render when authenticated.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setAuthed(!!getSessionToken());
    const onStorage = () => setAuthed(!!getSessionToken());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const load = useMemo(
    () =>
      async (markRead = false) => {
        try {
          const res = await fetchMySupportThread();
          setMessages(res.messages);
          setUnread(res.conversation.unreadForUser);
          setLoaded(true);
          if (markRead && res.conversation.unreadForUser > 0) {
            await markSupportThreadRead();
            setUnread(0);
          }
        } catch {
          /* polling will retry */
        }
      },
    [],
  );

  // Poll. Faster when the chat view is open.
  useEffect(() => {
    if (!authed) return;
    void load(view === 'chat' && open);
    const interval = view === 'chat' && open ? POLL_MS_OPEN : POLL_MS_CLOSED;
    const id = window.setInterval(() => load(view === 'chat' && open), interval);
    return () => window.clearInterval(id);
  }, [authed, open, view, load]);

  useEffect(() => {
    if (view === 'chat') {
      requestAnimationFrame(() => listEndRef.current?.scrollIntoView({ behavior: 'smooth' }));
    }
  }, [view, messages.length]);

  if (!authed) return null;

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await sendSupportMessage(body);
      setMessages((prev) => [...prev, ...res.messages]);
      setDraft('');
    } catch {
      setError('Couldn’t send that — try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  const openWhatsApp = () => {
    // Placeholder — number to be supplied. For now we show a "coming soon"
    // toast and don't attempt to open wa.me.
    setError('WhatsApp support is coming soon — for now please use Live Chat or call.');
    setTimeout(() => setError(null), 4000);
  };

  return (
    <>
      {/* Floating launcher */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close help' : 'Open help'}
        className="fixed bottom-5 right-5 z-[60] inline-flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-xl shadow-brand-600/30 transition hover:bg-brand-700"
      >
        {open ? <CloseIcon /> : <ChatIcon />}
        {!open && unread > 0 && (
          <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed bottom-24 right-5 z-[60] flex h-[560px] w-[380px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          {view === 'menu' && (
            <MenuView
              onPickChat={() => {
                setView('connecting');
                window.setTimeout(() => {
                  setAiJoinedAt(new Date());
                  setView('chat');
                }, CONNECTING_MS);
              }}
              onPickWhatsApp={openWhatsApp}
              error={error}
            />
          )}
          {view === 'connecting' && <ConnectingView />}
          {view === 'chat' && (
            <ChatView
              loaded={loaded}
              messages={messages}
              draft={draft}
              setDraft={setDraft}
              sending={sending}
              error={error}
              onSend={handleSend}
              onBack={() => setView('menu')}
              listEndRef={listEndRef}
              aiJoinedAt={aiJoinedAt}
            />
          )}
        </div>
      )}
    </>
  );
}

function MenuView({
  onPickChat,
  onPickWhatsApp,
  error,
}: {
  onPickChat: () => void;
  onPickWhatsApp: () => void;
  error: string | null;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="bg-brand-600 px-5 py-5 text-white">
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-100">ReceptionMate support</p>
        <h2 className="mt-1 text-lg font-semibold">How can we help today?</h2>
        <p className="mt-0.5 text-xs text-brand-100">
          Most questions get answered instantly by our AI assistant. For anything more, you can reach the team.
        </p>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 px-5 py-6">
        <TileButton
          onClick={onPickChat}
          accent="brand"
          icon={<SparkleIcon />}
          title="Speak to support"
          subtitle="Quickest way to get help — usually answered within seconds."
        />
        <TileButton
          onClick={onPickWhatsApp}
          accent="emerald"
          icon={<WhatsAppIcon />}
          title="Message us on WhatsApp"
          subtitle="Chat to the team from your phone. (Coming soon.)"
          dimmed
        />
        <a
          href={`tel:${SUPPORT_PHONE_DIAL}`}
          className="block rounded-xl border border-slate-200 bg-white p-3 transition hover:border-slate-300 hover:shadow-sm"
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
              <PhoneIcon />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900">Call us</p>
              <p className="mt-0.5 text-xs text-slate-500">
                <span className="font-mono text-slate-700">{SUPPORT_PHONE_DISPLAY}</span> — UK office hours
              </p>
            </div>
            <span className="text-xs font-medium text-brand-600">Dial →</span>
          </div>
        </a>
        {error ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">{error}</p>
        ) : null}
      </div>
    </div>
  );
}

function TileButton({
  onClick,
  icon,
  title,
  subtitle,
  accent,
  dimmed,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  accent: 'brand' | 'emerald';
  dimmed?: boolean;
}) {
  const accentBg = accent === 'brand' ? 'bg-brand-100 text-brand-600' : 'bg-emerald-100 text-emerald-700';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:border-slate-300 hover:shadow-sm ${
        dimmed ? 'opacity-70' : ''
      }`}
    >
      <div className="flex items-center gap-3">
        <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${accentBg}`}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">{title}</p>
          <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
        </div>
        <span className="text-xs font-medium text-brand-600">Start →</span>
      </div>
    </button>
  );
}

function ConnectingView() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 bg-brand-600 px-4 py-3 text-white">
        <div className="h-8 w-8" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Support</p>
          <p className="text-xs text-brand-100">Finding someone to help…</p>
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-slate-200">
            <Spinner />
          </div>
          <p className="text-sm font-medium text-slate-700">Connecting you to an agent…</p>
          <p className="text-xs text-slate-500">Usually under a second.</p>
        </div>
      </div>
    </div>
  );
}

function ChatView({
  loaded,
  messages,
  draft,
  setDraft,
  sending,
  error,
  onSend,
  onBack,
  listEndRef,
  aiJoinedAt,
}: {
  loaded: boolean;
  messages: SupportMessage[];
  draft: string;
  setDraft: (s: string) => void;
  sending: boolean;
  error: string | null;
  onSend: (e: React.FormEvent) => void;
  onBack: () => void;
  listEndRef: React.RefObject<HTMLDivElement | null>;
  aiJoinedAt: Date | null;
}) {
  return (
    <>
      <header className="flex items-center gap-3 bg-brand-600 px-4 py-3 text-white">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to menu"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
        >
          <BackIcon />
        </button>
        <AiAvatar size={32} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{AI_PERSONA.name}</p>
          <p className="text-xs text-brand-100">{AI_PERSONA.title} · replies instantly</p>
        </div>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 px-4 py-4">
        {!loaded ? (
          <p className="text-center text-xs text-slate-500">Loading…</p>
        ) : (
          <>
            {aiJoinedAt ? <JoinedNotice when={aiJoinedAt} /> : null}
            {messages.length === 0 ? <AiEmptyState /> : messages.map((m) => <Bubble key={m.id} m={m} />)}
          </>
        )}
        <div ref={listEndRef} />
      </div>

      {error ? <p className="bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</p> : null}

      <form onSubmit={onSend} className="flex items-end gap-2 border-t border-slate-200 bg-white p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onSend(e);
            }
          }}
          placeholder="Type your question…"
          rows={2}
          className="flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
        <button
          type="submit"
          disabled={sending || draft.trim().length === 0}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm hover:bg-brand-700 disabled:bg-slate-300"
          aria-label="Send"
        >
          {sending ? <Spinner /> : <SendIcon />}
        </button>
      </form>
    </>
  );
}

function JoinedNotice({ when }: { when: Date }) {
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(when);
  return (
    <div className="my-2 flex items-center gap-2">
      <span className="h-px flex-1 bg-slate-200" />
      <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
        <AiAvatar size={16} />
        {AI_PERSONA.name} joined the chat · {time}
      </span>
      <span className="h-px flex-1 bg-slate-200" />
    </div>
  );
}

function AiEmptyState() {
  return (
    <div className="flex items-start gap-2.5">
      <AiAvatar size={32} />
      <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-white px-3 py-2.5 text-sm shadow-sm ring-1 ring-slate-200">
        <p className="font-semibold text-slate-900">Hi 👋 I'm {AI_PERSONA.name}.</p>
        <p className="mt-1 text-sm text-slate-700">
          Ask me about your account, agent setup, billing — anything portal-related. If I can&rsquo;t help I&rsquo;ll raise a support ticket for the team.
        </p>
        <p className="mt-2 text-[10px] uppercase tracking-wider text-slate-400">{AI_PERSONA.title}</p>
      </div>
    </div>
  );
}

function Bubble({ m }: { m: SupportMessage }) {
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(m.createdAt));

  if (m.senderRole === 'system') {
    return (
      <div className="my-2 flex items-center gap-2">
        <span className="h-px flex-1 bg-slate-200" />
        <span className="text-[10px] uppercase tracking-wider text-slate-500">{m.body}</span>
        <span className="h-px flex-1 bg-slate-200" />
      </div>
    );
  }

  if (m.senderRole === 'customer') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-brand-600 px-3 py-2 text-sm text-white shadow-sm">
          <p className="whitespace-pre-wrap break-words">{m.body}</p>
          <p className="mt-1 text-[10px] text-brand-100">{time}</p>
        </div>
      </div>
    );
  }

  if (m.senderRole === 'ai') {
    return (
      <div className="flex items-start gap-2.5">
        <AiAvatar size={28} />
        <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-slate-200">
          <p className="whitespace-pre-wrap break-words">{m.body}</p>
          <p className="mt-1 text-[10px] text-slate-500">{AI_PERSONA.name} · {time}</p>
        </div>
      </div>
    );
  }

  // Real staff reply
  return (
    <div className="flex items-start gap-2.5">
      <RepAvatar size={28} />
      <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-slate-200">
        <p className="whitespace-pre-wrap break-words">{m.body}</p>
        <p className="mt-1 text-[10px] text-slate-500">{SUPPORT_REP.name} · {time}</p>
      </div>
    </div>
  );
}

function RepAvatar({ size = 28, ring = false }: { size?: number; ring?: boolean }) {
  const initial = SUPPORT_REP.name.charAt(0).toUpperCase();
  if (SUPPORT_REP.avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={SUPPORT_REP.avatarUrl}
        alt={SUPPORT_REP.name}
        style={{ width: size, height: size }}
        className={`shrink-0 rounded-full object-cover ${ring ? 'ring-2 ring-white/30' : ''}`}
      />
    );
  }
  return (
    <span
      aria-label={SUPPORT_REP.name}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 font-semibold text-white ${
        ring ? 'ring-2 ring-white/30' : ''
      }`}
    >
      {initial}
    </span>
  );
}

function AiAvatar({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-label="AI assistant"
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 via-fuchsia-500 to-amber-400 text-white shadow-sm"
    >
      <svg
        width={Math.round(size * 0.6)}
        height={Math.round(size * 0.6)}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" />
        <path d="M19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z" />
      </svg>
    </span>
  );
}

function ChatIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22l-4-9-9-4 20-7z" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" />
      <path d="M19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}
