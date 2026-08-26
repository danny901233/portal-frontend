'use client';

// Support hub Phase 2 continuation — staff-facing ticket queue.
// Left column: filterable list. Right column: selected ticket thread + reply form.
// Reads/writes the Ticket / Contact / TicketEntry tables via /api/admin/tickets.
// Legacy widget UI at /admin/support still exists — the two coexist per PR #381
// (ticket-model migration from SupportConversation is deferred).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isReceptionMateStaff, getUserId } from '../../lib/auth';
import {
  fetchTickets,
  fetchTicket,
  fetchTicketQueueCounts,
  replyToTicket,
  addTicketNote,
  changeTicketStatus,
  assignTicket,
  type TicketSummary,
  type TicketDetail,
  type TicketEntry,
  type TicketQueueCounts,
  type TicketStatus,
} from '../../lib/api';

const POLL_MS = 20_000;

const STATUS_LABEL: Record<TicketStatus, string> = {
  new: 'New',
  open: 'Open',
  pending: 'Pending',
  on_hold: 'On hold',
  solved: 'Solved',
  closed: 'Closed',
};

const STATUS_TONE: Record<TicketStatus, string> = {
  new:     'bg-blue-50 text-blue-700 ring-blue-200',
  open:    'bg-amber-50 text-amber-700 ring-amber-200',
  pending: 'bg-violet-50 text-violet-700 ring-violet-200',
  on_hold: 'bg-slate-50 text-slate-700 ring-slate-200',
  solved:  'bg-emerald-50 text-emerald-700 ring-emerald-200',
  closed:  'bg-slate-100 text-slate-600 ring-slate-300',
};

const PRIORITY_TONE: Record<string, string> = {
  low:    'text-slate-500',
  normal: 'text-slate-700',
  high:   'text-orange-600 font-semibold',
  urgent: 'text-rose-600 font-bold',
};

type StatusFilter = TicketStatus | 'all';

export default function AdminTicketsPage() {
  const router = useRouter();
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [counts, setCounts] = useState<TicketQueueCounts | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [entries, setEntries] = useState<TicketEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [draftMode, setDraftMode] = useState<'reply' | 'note'>('reply');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isReceptionMateStaff()) {
      router.replace('/dashboard');
    }
  }, [router]);

  const loadList = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([
        fetchTickets(statusFilter === 'all' ? {} : { status: statusFilter }),
        fetchTicketQueueCounts(),
      ]);
      setTickets(t.tickets);
      setCounts(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tickets');
    }
  }, [statusFilter]);

  const loadThread = useCallback(async (id: string) => {
    try {
      const res = await fetchTicket(id);
      setSelected(res.ticket);
      setEntries(res.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load ticket');
    }
  }, []);

  useEffect(() => {
    void loadList();
    const t = window.setInterval(loadList, POLL_MS);
    return () => window.clearInterval(t);
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) return;
    void loadThread(selectedId);
    const t = window.setInterval(() => loadThread(selectedId), POLL_MS);
    return () => window.clearInterval(t);
  }, [selectedId, loadThread]);

  useEffect(() => {
    if (selectedId) requestAnimationFrame(() => listEndRef.current?.scrollIntoView({ behavior: 'smooth' }));
  }, [entries.length, selectedId]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      if (draftMode === 'reply') await replyToTicket(selectedId, draft.trim());
      else await addTicketNote(selectedId, draft.trim());
      setDraft('');
      void loadThread(selectedId);
      void loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to post ${draftMode}`);
    } finally {
      setSending(false);
    }
  };

  const handleStatusChange = async (next: TicketStatus) => {
    if (!selectedId || !selected || selected.status === next) return;
    try {
      await changeTicketStatus(selectedId, next);
      void loadThread(selectedId);
      void loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change status');
    }
  };

  const handleAssignSelf = async () => {
    if (!selectedId) return;
    const uid = getUserId();
    if (!uid) return;
    try {
      await assignTicket(selectedId, uid);
      void loadThread(selectedId);
      void loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to assign');
    }
  };

  const handleUnassign = async () => {
    if (!selectedId) return;
    try {
      await assignTicket(selectedId, null);
      void loadThread(selectedId);
      void loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to unassign');
    }
  };

  const filterButtons: { key: StatusFilter; label: string }[] = useMemo(() => [
    { key: 'all',     label: 'All' },
    { key: 'new',     label: 'New' },
    { key: 'open',    label: 'Open' },
    { key: 'pending', label: 'Pending' },
    { key: 'solved',  label: 'Solved' },
    { key: 'closed',  label: 'Closed' },
  ], []);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Support tickets</h1>
          <p className="mt-1 text-sm text-slate-500">
            Ticket queue for email + WhatsApp inbound. In-portal chat still lives on the{' '}
            <a href="/admin/support" className="text-brand-600 hover:underline">legacy support page</a>.
          </p>
        </div>
        {counts && (
          <div className="flex gap-2 text-xs">
            <QueueChip label="Unassigned" value={counts.unassigned} tone="rose" />
            <QueueChip label="Mine open"  value={counts.mineOpen}   tone="brand" />
            <QueueChip label="Stale 3d+"  value={counts.pendingStale} tone="amber" />
          </div>
        )}
      </header>

      <div className="flex flex-wrap gap-1">
        {filterButtons.map((b) => (
          <button
            key={b.key}
            type="button"
            onClick={() => { setStatusFilter(b.key); setSelectedId(null); setSelected(null); }}
            className={`rounded-md border px-3 py-1 text-xs font-medium transition ${
              statusFilter === b.key
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:border-brand-600 hover:text-brand-600'
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      <div className="flex h-[calc(100vh-16rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {/* List */}
        <aside className="flex w-96 shrink-0 flex-col border-r border-slate-200 bg-slate-50">
          <ul className="flex-1 overflow-y-auto divide-y divide-slate-200">
            {tickets.length === 0 ? (
              <li className="px-4 py-8 text-center text-xs text-slate-500">No tickets match.</li>
            ) : (
              tickets.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(t.id)}
                    className={`block w-full px-4 py-3 text-left transition ${
                      t.id === selectedId ? 'bg-white' : 'hover:bg-white'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        #{t.number} · {t.title}
                      </p>
                      <StatusBadge status={t.status} />
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-600">
                      {t.contact.name ?? t.contact.email ?? t.contact.phone ?? 'Unknown contact'}
                    </p>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider text-slate-400">
                        {t.channel} · {new Date(t.updatedAt).toLocaleString('en-GB')}
                      </span>
                      <span className={`text-[10px] uppercase tracking-wider ${PRIORITY_TONE[t.priority] ?? ''}`}>
                        {t.priority}
                      </span>
                    </div>
                  </button>
                </li>
              ))
            )}
          </ul>
        </aside>

        {/* Thread */}
        <section className="flex flex-1 flex-col">
          {!selectedId || !selected ? (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
              Pick a ticket to view it.
            </div>
          ) : (
            <>
              <header className="border-b border-slate-200 bg-white px-5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Ticket #{selected.number} · {selected.channel}
                    </p>
                    <p className="truncate text-sm font-semibold text-slate-900">{selected.title}</p>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      From {selected.contact.name ?? selected.contact.email ?? selected.contact.phone ?? '—'}
                      {selected.garage && <> · {selected.garage.name}</>}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={selected.status}
                      onChange={(e) => handleStatusChange(e.target.value as TicketStatus)}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800"
                    >
                      {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((s) => (
                        <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                      ))}
                    </select>
                    {selected.assignee ? (
                      <span className="rounded-md bg-brand-50 px-2 py-1 text-xs text-brand-700 ring-1 ring-brand-200">
                        {selected.assignee.email}
                        <button
                          type="button"
                          onClick={handleUnassign}
                          className="ml-2 text-brand-500 hover:text-rose-600"
                          title="Unassign"
                        >×</button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={handleAssignSelf}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:border-brand-600 hover:text-brand-600"
                      >
                        Assign to me
                      </button>
                    )}
                  </div>
                </div>
              </header>

              <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 px-5 py-4">
                {entries.length === 0
                  ? <p className="text-center text-xs text-slate-500">No entries yet.</p>
                  : entries.map((e) => <EntryBubble key={e.id} e={e} />)}
                <div ref={listEndRef} />
              </div>

              {error && <p className="bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</p>}

              <form onSubmit={handleSend} className="border-t border-slate-200 bg-white p-3">
                <div className="mb-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDraftMode('reply')}
                    className={`rounded-md px-2 py-1 text-xs font-medium ${
                      draftMode === 'reply'
                        ? 'bg-brand-600 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    Public reply
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraftMode('note')}
                    className={`rounded-md px-2 py-1 text-xs font-medium ${
                      draftMode === 'note'
                        ? 'bg-amber-500 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    Internal note
                  </button>
                  <span className="text-[10px] text-slate-400">
                    {draftMode === 'reply'
                      ? 'Sent to customer (once channel-send is wired up)'
                      : 'Staff-only — never leaves the portal'}
                  </span>
                </div>
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void handleSend(e);
                      }
                    }}
                    placeholder={
                      draftMode === 'reply'
                        ? 'Type your reply — Cmd/Ctrl + Enter to send'
                        : 'Internal note — Cmd/Ctrl + Enter to save'
                    }
                    rows={3}
                    className={`flex-1 resize-none rounded-lg border px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-1 ${
                      draftMode === 'reply'
                        ? 'border-slate-300 bg-white focus:border-brand-600 focus:ring-brand-600'
                        : 'border-amber-300 bg-amber-50 focus:border-amber-500 focus:ring-amber-500'
                    }`}
                  />
                  <button
                    type="submit"
                    disabled={sending || draft.trim().length === 0}
                    className={`rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:bg-slate-300 ${
                      draftMode === 'reply' ? 'bg-brand-600 hover:bg-brand-700' : 'bg-amber-500 hover:bg-amber-600'
                    }`}
                  >
                    {sending ? 'Sending…' : draftMode === 'reply' ? 'Send reply' : 'Save note'}
                  </button>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ring-1 ${STATUS_TONE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function QueueChip({ label, value, tone }: { label: string; value: number; tone: 'rose' | 'brand' | 'amber' }) {
  const tones: Record<string, string> = {
    rose:  'bg-rose-50 text-rose-700 ring-rose-200',
    brand: 'bg-brand-50 text-brand-700 ring-brand-200',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 font-semibold ring-1 ${tones[tone]}`}>
      {label}
      <span className="rounded-full bg-white/70 px-1.5 text-[10px]">{value}</span>
    </span>
  );
}

function EntryBubble({ e }: { e: TicketEntry }) {
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(e.createdAt));

  if (e.kind === 'status_change' || e.kind === 'assignment_change') {
    return (
      <div className="my-2 flex items-center gap-2">
        <span className="h-px flex-1 bg-slate-200" />
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          {e.body} · {e.authorUser?.email ?? 'system'} · {time}
        </span>
        <span className="h-px flex-1 bg-slate-200" />
      </div>
    );
  }
  if (e.kind === 'auto_ack') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl rounded-tr-sm bg-violet-50 px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-violet-200">
          <p className="whitespace-pre-wrap break-words">{e.body}</p>
          <p className="mt-1 text-[10px] text-violet-700">Auto-ack · {time}</p>
        </div>
      </div>
    );
  }
  if (e.kind === 'internal_note') {
    return (
      <div className="flex justify-center">
        <div className="max-w-[90%] rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-sm text-slate-900">
          <p className="whitespace-pre-wrap break-words">{e.body}</p>
          <p className="mt-1 text-[10px] text-amber-700">Internal note · {e.authorUser?.email ?? 'Staff'} · {time}</p>
        </div>
      </div>
    );
  }
  // public_reply
  const isStaff = !!e.authorUserId;
  return (
    <div className={isStaff ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
          isStaff ? 'bg-brand-600 text-white' : 'bg-white text-slate-900 ring-1 ring-slate-200'
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{e.body}</p>
        <p className={`mt-1 text-[10px] ${isStaff ? 'text-brand-100' : 'text-slate-500'}`}>
          {isStaff ? (e.authorUser?.email ?? 'Staff') : (e.authorContact?.name ?? e.authorContact?.email ?? 'Customer')}
          {e.isDraft && ' · DRAFT'}
          {' · '}{time}
        </p>
      </div>
    </div>
  );
}
