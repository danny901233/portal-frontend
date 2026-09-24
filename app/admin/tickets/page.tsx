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
  composeTicket,
  markTicketSpam,
  markTicketNotSpam,
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

// 'spam' is a category, not a status: everything filed as spam, whatever
// state it is in, so a wrongly-filed enquiry can be found and rescued.
// 'stale' is pending with no reply for 3+ days — what the Stale chip counts.
type StatusFilter = TicketStatus | 'all' | 'spam' | 'stale';

export default function AdminTicketsPage() {
  const router = useRouter();
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [counts, setCounts] = useState<TicketQueueCounts | null>(null);
  // Opens on New, not All. "All" includes every receipt and supplier notice ever
  // filed and closed on the way in, which buries the handful of things that
  // actually want attention.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('new');
  const [search, setSearch] = useState('');
  const [pendingDraftLoad, setPendingDraftLoad] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [entries, setEntries] = useState<TicketEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [draftMode, setDraftMode] = useState<'reply' | 'note'>('reply');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);
  // Outbound: we start the conversation. Takes the thread pane's place until
  // it is sent or abandoned.
  const [composing, setComposing] = useState(false);
  const [compose, setCompose] = useState({ to: '', name: '', subject: '', body: '' });
  const [composeError, setComposeError] = useState<string | null>(null);

  useEffect(() => {
    if (!isReceptionMateStaff()) {
      router.replace('/dashboard');
    }
  }, [router]);

  // Opened from a push notification: /admin/tickets?ticket=<id>. The queue
  // defaults to New, and the ticket being linked to may be any status, so select
  // it directly rather than hoping it is in the current filter.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('ticket');
    if (wanted) setSelectedId(wanted);
    // &draft=1 comes from "Edit & send" on a notification: the reader wants the
    // AI's draft in the box, edited, not retyped.
    if (params.get('draft') === '1') setPendingDraftLoad(true);
  }, []);

  // Wait for the thread before loading the draft — the entries arrive after the
  // ticket id does, and there is nothing to load until they have.
  useEffect(() => {
    if (!pendingDraftLoad || entries.length === 0) return;
    const draft = [...entries].reverse().find((e) => e.isDraft);
    if (!draft) return;
    setPendingDraftLoad(false);
    useDraft(draft.body);
  }, [pendingDraftLoad, entries]);

  const loadList = useCallback(async () => {
    try {
      // A reference search ignores the status filter, so someone quoting a
      // closed ticket's reference still finds it.
      const filters = search.trim()
        ? { ref: search.trim() }
        : statusFilter === 'all' ? {}
        : statusFilter === 'spam' ? { category: 'spam' as const }
        : statusFilter === 'stale' ? { stale: true }
        : { status: statusFilter };
      const [t, c] = await Promise.all([
        fetchTickets(filters),
        fetchTicketQueueCounts(),
      ]);
      setTickets(t.tickets);
      setCounts(c);
      // One hit on a reference search is the ticket they were looking for.
      if (search.trim() && t.tickets.length === 1) setSelectedId(t.tickets[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tickets');
    }
  }, [statusFilter, search]);

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

  /** Load an AI draft into the reply box rather than sending it outright.
   *  The extra read-and-press is the point: whoever sends it is then the author,
   *  and a fluent-but-wrong draft gets caught before it leaves. */
  const useDraft = (body: string) => {
    setDraftMode('reply');
    setDraft(body);
    requestAnimationFrame(() => {
      const box = document.querySelector<HTMLTextAreaElement>('form textarea');
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
    });
  };

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

  // Working a queue: closing one ticket opens the one below it, so New can be
  // read top to bottom without going back to the list each time. Falls back to
  // the one above at the bottom of the list, and to nothing when it was alone.
  const ticketBelow = (id: string): string | null => {
    const i = tickets.findIndex((t) => t.id === id);
    if (i < 0) return null;
    return tickets[i + 1]?.id ?? tickets[i - 1]?.id ?? null;
  };

  const handleStatusChange = async (next: TicketStatus) => {
    if (!selectedId || !selected || selected.status === next) return;
    const closing = next === 'closed';
    const following = closing ? ticketBelow(selectedId) : null;
    try {
      await changeTicketStatus(selectedId, next);
      if (closing) {
        const leaves = statusFilter !== 'all' && statusFilter !== 'closed' && statusFilter !== 'spam';
        if (leaves) setTickets((prev) => prev.filter((t) => t.id !== selectedId));
        setSelectedId(following);
        if (!following) setSelected(null);
      } else {
        void loadThread(selectedId);
      }
      void loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change status');
    }
  };

  // One click from the list, without opening the ticket. The row leaves the
  // list straight away when the current filter would no longer include it —
  // that is the whole point of working through a queue quickly.
  const handleQuickClose = async (id: string) => {
    const leaves = statusFilter !== 'all' && statusFilter !== 'closed' && statusFilter !== 'spam';
    const following = ticketBelow(id);
    if (leaves) setTickets((prev) => prev.filter((t) => t.id !== id));
    try {
      await changeTicketStatus(id, 'closed');
      setComposing(false);
      setSelectedId(following);
      if (!following) setSelected(null);
      void loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to close ticket');
      void loadList();
    }
  };

  const openCompose = () => {
    setSelectedId(null);
    setSelected(null);
    setComposeError(null);
    setComposing(true);
  };

  const handleCompose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setComposeError(null);
    try {
      const res = await composeTicket({
        to: compose.to.trim(),
        name: compose.name.trim() || undefined,
        subject: compose.subject.trim(),
        body: compose.body.trim(),
      });
      setCompose({ to: '', name: '', subject: '', body: '' });
      setComposing(false);
      // Sent tickets are Pending, which the default New filter hides — show it
      // anyway so the sender sees it went.
      setSelectedId(res.ticket.id);
      void loadList();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setComposeError(msg ?? (err instanceof Error ? err.message : 'Failed to send'));
    } finally {
      setSending(false);
    }
  };

  const handleSpam = async () => {
    if (!selectedId || !selected) return;
    const who = selected.contact.email ?? selected.contact.phone ?? 'this sender';
    if (!window.confirm(`Mark as spam and block ${who}? Their future emails will be dropped.`)) return;
    try {
      await markTicketSpam(selectedId);
      void loadThread(selectedId);
      void loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to mark as spam');
    }
  };

  const handleNotSpam = async () => {
    if (!selectedId) return;
    try {
      await markTicketNotSpam(selectedId);
      void loadThread(selectedId);
      void loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to restore ticket');
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
    { key: 'spam',    label: 'Spam' },
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
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {counts && (
            <>
              <QueueChip label="Unassigned" value={counts.unassigned} tone="rose" />
              <QueueChip label="Mine open"  value={counts.mineOpen}   tone="brand" />
              <QueueChip
                label="Stale 3d+"
                value={counts.pendingStale}
                tone="amber"
                active={statusFilter === 'stale'}
                onClick={() => { setStatusFilter('stale'); setSelectedId(null); setSelected(null); setComposing(false); }}
              />
            </>
          )}
          <button
            type="button"
            onClick={openCompose}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-brand-700"
          >
            New email
          </button>
        </div>
      </header>

      <div className="flex flex-wrap gap-1">
        {filterButtons.map((b) => (
          <button
            key={b.key}
            type="button"
            onClick={() => { setStatusFilter(b.key); setSelectedId(null); setSelected(null); setComposing(false); }}
            className={`rounded-md border px-3 py-1 text-xs font-medium transition ${
              statusFilter === b.key
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:border-brand-600 hover:text-brand-600'
            }`}
          >
            {b.label}
          </button>
        ))}

        {/* Reference lookup — what a customer quotes down the phone. */}
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setSearch(''); }}
            placeholder="Find by reference — RM-2SBXHMR or #7"
            className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-1 text-xs text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 sm:w-64 sm:flex-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => { setSearch(''); setSelectedId(null); setSelected(null); }}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:border-brand-600 hover:text-brand-600"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {search.trim() && (
        <p className="text-xs text-slate-500">
          Searching all statuses for <span className="font-mono font-semibold">{search.trim()}</span>
          {tickets.length === 0 && ' — nothing found'}
        </p>
      )}

      <div className="flex h-[calc(100vh-13rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm md:h-[calc(100vh-16rem)]">
        {/* List */}
        <aside
          className={`${selectedId || composing ? 'hidden md:flex' : 'flex'} w-full min-w-0 shrink-0 flex-col border-r border-slate-200 bg-slate-50 md:w-96`}
        >
          <ul className="flex-1 overflow-y-auto divide-y divide-slate-200">
            {tickets.length === 0 ? (
              <li className="px-4 py-8 text-center text-xs text-slate-500">No tickets match.</li>
            ) : (
              tickets.map((t) => (
                <li
                  key={t.id}
                  className={`group relative transition ${t.id === selectedId ? 'bg-white' : 'hover:bg-white'}`}
                >
                  <button
                    type="button"
                    onClick={() => { setComposing(false); setSelectedId(t.id); }}
                    className="block w-full px-4 py-3 text-left"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        #{t.number} · {t.title}
                      </p>
                      <StatusBadge status={t.status} />
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-600">
                      {t.contact.name ?? t.contact.email ?? t.contact.phone ?? 'Unknown contact'}
                      {t.category === 'spam' && (
                        <span className="ml-2 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-700 ring-1 ring-rose-200">
                          spam
                        </span>
                      )}
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
                  {/* Close without opening. Sits over the bottom-right corner so
                      the priority label underneath is not what gets clicked. On
                      a touch screen there is no hover, so it is always shown. */}
                  {t.status !== 'closed' && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void handleQuickClose(t.id); }}
                      title="Close ticket"
                      aria-label={`Close ticket #${t.number}`}
                      className="absolute bottom-2 right-3 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 shadow-sm hover:border-emerald-600 hover:text-emerald-700 md:opacity-0 md:transition md:group-hover:opacity-100 md:focus:opacity-100"
                    >
                      Close
                    </button>
                  )}
                </li>
              ))
            )}
          </ul>
        </aside>

        {/* Thread. On a phone this replaces the list rather than sitting beside
            it — a 384px list plus a thread does not fit, and the thread was the
            half pushed off-screen, so a notification opened a ticket you could
            not read. */}
        <section className={`${selectedId || composing ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
          {composing ? (
            <form onSubmit={handleCompose} className="flex flex-1 flex-col overflow-y-auto">
              <header className="border-b border-slate-200 bg-white px-5 py-3">
                <button
                  type="button"
                  onClick={() => setComposing(false)}
                  className="mb-2 text-xs font-medium text-brand-600 hover:underline md:hidden"
                >
                  ← All tickets
                </button>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">New email</p>
                <p className="text-sm text-slate-600">
                  Sent from hello@receptionmate.co.uk with a reference in the subject, so their reply lands on this ticket.
                </p>
              </header>
              <div className="flex-1 space-y-3 bg-slate-50 px-5 py-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs font-medium text-slate-700">
                    To
                    <input
                      type="email"
                      required
                      autoFocus
                      value={compose.to}
                      onChange={(e) => setCompose({ ...compose, to: e.target.value })}
                      placeholder="someone@garage.co.uk"
                      className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                    />
                  </label>
                  <label className="block text-xs font-medium text-slate-700">
                    Name <span className="font-normal text-slate-400">(optional)</span>
                    <input
                      type="text"
                      value={compose.name}
                      onChange={(e) => setCompose({ ...compose, name: e.target.value })}
                      placeholder="Sarah"
                      className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                    />
                  </label>
                </div>
                <label className="block text-xs font-medium text-slate-700">
                  Subject
                  <input
                    type="text"
                    required
                    maxLength={300}
                    value={compose.subject}
                    onChange={(e) => setCompose({ ...compose, subject: e.target.value })}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                  />
                </label>
                <label className="block text-xs font-medium text-slate-700">
                  Message
                  <textarea
                    required
                    rows={10}
                    value={compose.body}
                    onChange={(e) => setCompose({ ...compose, body: e.target.value })}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                  />
                </label>
                {composeError && <p className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{composeError}</p>}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-white p-3">
                <button
                  type="button"
                  onClick={() => setComposing(false)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:border-brand-600 hover:text-brand-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sending}
                  className="rounded-md bg-brand-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50"
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          ) : !selectedId || !selected ? (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
              Pick a ticket to view it.
            </div>
          ) : (
            <>
              <header className="border-b border-slate-200 bg-white px-5 py-3">
                <button
                  type="button"
                  onClick={() => { setSelectedId(null); setSelected(null); }}
                  className="mb-2 text-xs font-medium text-brand-600 hover:underline md:hidden"
                >
                  ← All tickets
                </button>
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
                    {selected.status !== 'closed' && (
                      <button
                        type="button"
                        onClick={() => handleStatusChange('closed')}
                        className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700"
                      >
                        Close
                      </button>
                    )}
                    {selected.contact.blocked || selected.category === 'spam' ? (
                      <button
                        type="button"
                        onClick={handleNotSpam}
                        title={selected.contact.blocked ? 'Unblock the sender and reopen' : 'Reopen'}
                        className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100"
                      >
                        {selected.contact.blocked ? 'Not spam · unblock' : 'Not spam'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleSpam}
                        title="Close, file as spam and block the sender"
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:border-rose-500 hover:text-rose-600"
                      >
                        Spam
                      </button>
                    )}
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
                  : entries.map((e) => <EntryBubble key={e.id} e={e} onUseDraft={useDraft} />)}
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
                  {/* Hidden on a phone: it is a reminder, not a control, and on a
                      narrow screen it pushed the row wider than the viewport. The
                      old wording was also stale — email replies do send now. */}
                  <span className="hidden text-[10px] text-slate-400 sm:inline">
                    {draftMode === 'reply'
                      ? 'Emailed to the customer'
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

function QueueChip({ label, value, tone, active, onClick }: {
  label: string; value: number; tone: 'rose' | 'brand' | 'amber'; active?: boolean; onClick?: () => void;
}) {
  const tones: Record<string, string> = {
    rose:  'bg-rose-50 text-rose-700 ring-rose-200',
    brand: 'bg-brand-50 text-brand-700 ring-brand-200',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200',
  };
  const cls = `inline-flex items-center gap-1 rounded-full px-3 py-1 font-semibold ring-1 ${tones[tone]}` +
    (onClick ? ' cursor-pointer hover:ring-2' : '') + (active ? ' ring-2' : '');
  const inner = <>{label}<span className="rounded-full bg-white/70 px-1.5 text-[10px]">{value}</span></>;
  return onClick
    ? <button type="button" onClick={onClick} className={cls} aria-pressed={active}>{inner}</button>
    : <span className={cls}>{inner}</span>;
}

function EntryBubble({ e, onUseDraft }: { e: TicketEntry; onUseDraft?: (body: string) => void }) {
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
  // An AI draft is an unsent suggestion, so it belongs on OUR side of the thread.
  // It carries no authorUserId (nobody wrote it yet), which previously put it on
  // the customer's side looking like something they had said.
  if (e.isDraft) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl border border-dashed border-brand-400 bg-brand-50 px-3 py-2 text-sm text-slate-900">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-brand-700">
            Suggested reply · not sent
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words">{e.body}</p>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[10px] text-brand-700">Drafted by AI · {time}</span>
            {onUseDraft && (
              <button
                type="button"
                onClick={() => onUseDraft(e.body)}
                className="rounded-md bg-brand-600 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-brand-700"
              >
                Edit &amp; send
              </button>
            )}
          </div>
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
          {' · '}{time}
        </p>
      </div>
    </div>
  );
}
