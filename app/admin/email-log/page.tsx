'use client';

// Every email the portal has sent, and what Mailgun did with it. Exists to answer the
// support question we previously could not: "did we actually email them, and did it land?"
// Before this, the only trace was a console.log in pm2's stdout that rotated away.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isReceptionMateStaff } from '../../lib/auth';
import api from '../../lib/api';

type EmailLogRow = {
  id: string;
  to: string[];
  cc: string[];
  subject: string;
  template: string;
  garageId: string | null;
  businessId: string | null;
  userId: string | null;
  pendingSignupId: string | null;
  transport: string;
  status: string;
  error: string | null;
  sentAt: string;
  deliveredAt: string | null;
  failedAt: string | null;
};

type TemplateCount = { template: string; count: number };

const PAGE_SIZE = 50;

// Delivered and bounced are the two that actually answer a support question, so they carry
// the strongest colour; "sent" is deliberately muted because on its own it proves only that
// Mailgun accepted it, not that anyone received it.
const STATUS_STYLE: Record<string, string> = {
  delivered: 'bg-emerald-100 text-emerald-800',
  sent: 'bg-slate-100 text-slate-700',
  opened: 'bg-sky-100 text-sky-800',
  bounced: 'bg-red-100 text-red-800',
  complained: 'bg-amber-100 text-amber-900',
  failed: 'bg-red-100 text-red-800',
};

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function AdminEmailLogPage() {
  const router = useRouter();

  const [rows, setRows] = useState<EmailLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [templates, setTemplates] = useState<TemplateCount[]>([]);
  const [toFilter, setToFilter] = useState('');
  const [templateFilter, setTemplateFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // Applied search, separate from the input, so typing does not fire a request per keystroke.
  const [appliedTo, setAppliedTo] = useState('');

  useEffect(() => {
    if (!isReceptionMateStaff()) {
      router.replace('/dashboard');
    }
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (appliedTo) params.set('to', appliedTo);
      if (templateFilter) params.set('template', templateFilter);
      if (statusFilter) params.set('status', statusFilter);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(offset));

      const { data } = await api.get<{ rows: EmailLogRow[]; total: number }>(
        `/admin/email-log?${params.toString()}`,
      );
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      console.error(err);
      setError('Could not load the email log.');
    } finally {
      setLoading(false);
    }
  }, [appliedTo, templateFilter, statusFilter, offset]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    api.get<{ templates: TemplateCount[] }>('/admin/email-log/templates')
      .then(({ data }) => setTemplates(data.templates ?? []))
      .catch(() => { /* filter just stays empty — not worth blocking the page */ });
  }, []);

  const applySearch = () => { setOffset(0); setAppliedTo(toFilter.trim().toLowerCase()); };

  const untaggedCount = templates.find((t) => t.template === 'unknown')?.count ?? 0;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-900">Email log</h1>
        <p className="mt-1 text-sm text-ink-600">
          Every email the portal has sent, with what Mailgun did with it. Subjects only —
          message bodies are never stored.
        </p>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-ink-200 bg-white p-4">
        <div className="flex-1 min-w-[260px]">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-500">
            Recipient
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={toFilter}
              onChange={(e) => setToFilter(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }}
              placeholder="full email address"
              className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm"
            />
            <button
              onClick={applySearch}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Search
            </button>
          </div>
          {/* The address is matched exactly, not as a fragment — worth saying, because an
              empty result for a half-typed address otherwise reads as "we never emailed them". */}
          <p className="mt-1 text-[11px] text-ink-500">Matches the full address, not part of one.</p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-500">
            Type
          </label>
          <select
            value={templateFilter}
            onChange={(e) => { setOffset(0); setTemplateFilter(e.target.value); }}
            className="rounded-lg border border-ink-300 px-3 py-2 text-sm"
          >
            <option value="">All types</option>
            {templates.map((t) => (
              <option key={t.template} value={t.template}>{t.template} ({t.count})</option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-500">
            Status
          </label>
          <select
            value={statusFilter}
            onChange={(e) => { setOffset(0); setStatusFilter(e.target.value); }}
            className="rounded-lg border border-ink-300 px-3 py-2 text-sm"
          >
            <option value="">All</option>
            <option value="sent">Sent</option>
            <option value="delivered">Delivered</option>
            <option value="opened">Opened</option>
            <option value="bounced">Bounced</option>
            <option value="complained">Complained</option>
            <option value="failed">Failed</option>
          </select>
        </div>

        {(appliedTo || templateFilter || statusFilter) && (
          <button
            onClick={() => {
              setToFilter(''); setAppliedTo(''); setTemplateFilter(''); setStatusFilter(''); setOffset(0);
            }}
            className="rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-50"
          >
            Clear
          </button>
        )}
      </div>

      {untaggedCount > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <strong>{untaggedCount}</strong> {untaggedCount === 1 ? 'email is' : 'emails are'} logged
          as <code>unknown</code> — those senders have not been given a type tag yet.
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-ink-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-3">Sent</th>
              <th className="px-4 py-3">To</th>
              <th className="px-4 py-3">Subject</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {loading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-500">Loading…</td></tr>
            )}

            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-ink-500">
                  {appliedTo || templateFilter || statusFilter
                    ? 'No emails match those filters.'
                    : 'No emails logged yet. Logging started on 21 September 2026 — anything sent before that is not here.'}
                </td>
              </tr>
            )}

            {!loading && rows.map((r) => (
              <tr key={r.id} className="align-top hover:bg-ink-50/60">
                <td className="whitespace-nowrap px-4 py-3 text-ink-700">{formatWhen(r.sentAt)}</td>
                <td className="px-4 py-3">
                  <div className="text-ink-900">{r.to.join(', ') || '—'}</div>
                  {r.cc.length > 0 && (
                    <div className="text-xs text-ink-500">cc: {r.cc.join(', ')}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-ink-800">{r.subject}</td>
                <td className="px-4 py-3">
                  <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-700">
                    {r.template}
                  </code>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[r.status] ?? 'bg-ink-100 text-ink-700'}`}>
                    {r.status}
                  </span>
                  {r.deliveredAt && (
                    <div className="mt-1 text-[11px] text-ink-500">{formatWhen(r.deliveredAt)}</div>
                  )}
                  {r.error && (
                    <div className="mt-1 max-w-xs truncate text-[11px] text-red-700" title={r.error}>
                      {r.error}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm text-ink-600">
        <span>
          {total === 0 ? 'No results' : `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}`}
        </span>
        <div className="flex gap-2">
          <button
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="rounded-lg border border-ink-300 px-3 py-1.5 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            disabled={offset + rows.length >= total || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="rounded-lg border border-ink-300 px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
