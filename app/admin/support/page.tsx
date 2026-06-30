'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isReceptionMateStaff } from '../../lib/auth';
import {
  fetchAdminSupportConversation,
  fetchAdminSupportConversations,
  markAdminSupportRead,
  sendAdminSupportReply,
  type AdminSupportConversation,
  type SupportMessage,
} from '../../lib/api';

const POLL_MS = 15_000;

export default function AdminSupportPage() {
  const router = useRouter();
  const [conversations, setConversations] = useState<AdminSupportConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminSupportConversation | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isReceptionMateStaff()) {
      router.replace('/dashboard');
    }
  }, [router]);

  const loadList = useMemo(
    () =>
      async () => {
        try {
          const res = await fetchAdminSupportConversations();
          setConversations(res.conversations);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Failed to load conversations');
        }
      },
    [],
  );

  const loadThread = useMemo(
    () =>
      async (id: string, markRead = false) => {
        try {
          const res = await fetchAdminSupportConversation(id);
          setSelected(res.conversation);
          setMessages(res.messages);
          if (markRead) {
            await markAdminSupportRead(id);
            // Reflect locally so badge updates immediately
            setConversations((prev) =>
              prev.map((c) => (c.id === id ? { ...c, unreadForStaff: 0 } : c)),
            );
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Failed to load conversation');
        }
      },
    [],
  );

  useEffect(() => {
    void loadList();
    const t = window.setInterval(loadList, POLL_MS);
    return () => window.clearInterval(t);
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) return;
    void loadThread(selectedId, true);
    const t = window.setInterval(() => loadThread(selectedId, false), POLL_MS);
    return () => window.clearInterval(t);
  }, [selectedId, loadThread]);

  useEffect(() => {
    if (selectedId) {
      requestAnimationFrame(() => listEndRef.current?.scrollIntoView({ behavior: 'smooth' }));
    }
  }, [messages.length, selectedId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) =>
        c.user.email.toLowerCase().includes(q) ||
        (c.lastMessageText ?? '').toLowerCase().includes(q),
    );
  }, [conversations, search]);

  const handleReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await sendAdminSupportReply(selectedId, draft.trim());
      setMessages((prev) => [...prev, res.message]);
      setDraft('');
      // Refresh list ordering immediately so this thread floats to the top
      void loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send reply');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Customer support</h1>
        <p className="mt-1 text-sm text-slate-500">
          Conversations from the in-portal chat widget. Threads with unread customer messages sort to the top.
        </p>
      </header>

      <div className="flex h-[calc(100vh-12rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {/* List */}
        <aside className="flex w-80 shrink-0 flex-col border-r border-slate-200 bg-slate-50">
          <div className="border-b border-slate-200 bg-white px-4 py-3">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by email or message"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </div>
          <ul className="flex-1 overflow-y-auto divide-y divide-slate-200">
            {filtered.length === 0 ? (
              <li className="px-4 py-8 text-center text-xs text-slate-500">
                No conversations match.
              </li>
            ) : (
              filtered.map((c) => {
                const isActive = c.id === selectedId;
                const hasUnread = c.unreadForStaff > 0;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={`block w-full px-4 py-3 text-left transition ${
                        isActive ? 'bg-white' : hasUnread ? 'bg-brand-50 hover:bg-white' : 'hover:bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className={`truncate text-sm ${hasUnread ? 'font-semibold text-slate-900' : 'text-slate-800'}`}>
                          {c.user.email}
                        </p>
                        {hasUnread && (
                          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                            {c.unreadForStaff}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-xs text-slate-500">
                        {c.lastMessageText ?? 'No messages yet'}
                      </p>
                      <p className="mt-1 text-[10px] uppercase tracking-wider text-slate-400">
                        {new Date(c.lastMessageAt).toLocaleString('en-GB')}
                      </p>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </aside>

        {/* Thread */}
        <section className="flex flex-1 flex-col">
          {!selectedId ? (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
              Pick a conversation to view it.
            </div>
          ) : (
            <>
              <header className="border-b border-slate-200 bg-white px-5 py-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Conversation with</p>
                <p className="text-sm font-semibold text-slate-900">{selected?.user.email ?? 'Loading…'}</p>
              </header>

              <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 px-5 py-4">
                {messages.length === 0 ? (
                  <p className="text-center text-xs text-slate-500">No messages yet.</p>
                ) : (
                  messages.map((m) => <AdminBubble key={m.id} m={m} />)
                )}
                <div ref={listEndRef} />
              </div>

              {error ? <p className="bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</p> : null}

              <form onSubmit={handleReply} className="flex items-end gap-2 border-t border-slate-200 bg-white p-3">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void handleReply(e);
                    }
                  }}
                  placeholder="Reply to the customer — Cmd/Ctrl + Enter to send"
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                />
                <button
                  type="submit"
                  disabled={sending || draft.trim().length === 0}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:bg-slate-300"
                >
                  {sending ? 'Sending…' : 'Send reply'}
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function AdminBubble({ m }: { m: SupportMessage }) {
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
  if (m.senderRole === 'ai') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[75%] rounded-2xl rounded-tl-sm bg-violet-50 px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-violet-200">
          <p className="whitespace-pre-wrap break-words">{m.body}</p>
          <p className="mt-1 text-[10px] text-violet-700">Leah (AI) · {time}</p>
        </div>
      </div>
    );
  }
  const isStaff = m.senderRole === 'staff';
  return (
    <div className={isStaff ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
          isStaff ? 'bg-brand-600 text-white' : 'bg-white text-slate-900 ring-1 ring-slate-200'
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{m.body}</p>
        <p className={`mt-1 text-[10px] ${isStaff ? 'text-brand-100' : 'text-slate-500'}`}>
          {isStaff ? (m.sender?.email ?? 'Staff') : 'Customer'} · {time}
        </p>
      </div>
    </div>
  );
}
