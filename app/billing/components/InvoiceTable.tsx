'use client';

import type { Invoice } from '../../lib/billing';
import { downloadInvoicePdf, triggerPdfDownload, emailInvoiceCopies } from '../../lib/billing';
import { useMemo, useState } from 'react';
import { getUserEmail } from '../../lib/auth';
import { useLang } from '@/app/i18n/LocaleProvider';

interface InvoiceTableProps {
  invoices: Invoice[];
}

export default function InvoiceTable({ invoices }: InvoiceTableProps) {
  const lang = useLang();
  const c = {
    en: {
      downloadFailed: 'Failed to download invoice. Please try again.',
      noInvoices: 'No invoices yet',
      noInvoicesHint: 'Your invoices will appear here once billing starts',
      colInvoice: 'Invoice #',
      colBranch: 'Branch',
      colPeriod: 'Period',
      colAmount: 'Amount',
      colStatus: 'Status',
      colDate: 'Date',
      collectsOn: 'Collects on',
      collectedOn: 'Collected on',
      colActions: 'Actions',
      periodTo: 'to',
      downloading: 'Downloading...',
      downloadPdf: 'Download PDF',
      selectAll: 'Select all',
      selected: (n: number) => `${n} selected`,
      emailSelected: 'Email selected',
      emailThis: 'Email',
      emailHint: 'Tick invoices to email several at once',
      emailTitle: 'Email these invoices',
      emailToYou: 'These will be sent to you at',
      alsoSendTo: 'Also send to (optional)',
      alsoSendHint: 'e.g. your accountant or bookkeeper',
      sending: 'Sending…',
      send: 'Send',
      cancel: 'Cancel',
      emailFailed: 'Could not email those invoices. Please try again.',
      emailSent: (n: number, to: string) => `Sent ${n} invoice${n === 1 ? '' : 's'} to ${to}`,
      status: (s: string) => ({
        paid: 'Paid',
        pending: 'Pending',
        failed: 'Failed',
        draft: 'Draft',
      }[s.toLowerCase()] ?? s),
    },
    fr: {
      downloadFailed: 'Échec du téléchargement de la facture. Veuillez réessayer.',
      noInvoices: 'Aucune facture pour le moment',
      noInvoicesHint: 'Vos factures apparaîtront ici une fois la facturation démarrée',
      colInvoice: 'Facture n°',
      colBranch: 'Agence',
      colPeriod: 'Période',
      colAmount: 'Montant',
      colStatus: 'Statut',
      colDate: 'Date',
      collectsOn: 'Prélèvement le',
      collectedOn: 'Prélevé le',
      colActions: 'Actions',
      periodTo: 'au',
      downloading: 'Téléchargement...',
      downloadPdf: 'Télécharger le PDF',
      selectAll: 'Tout sélectionner',
      selected: (n: number) => `${n} sélectionnée(s)`,
      emailSelected: 'Envoyer par e-mail',
      emailThis: 'Envoyer',
      emailHint: 'Cochez des factures pour en envoyer plusieurs',
      emailTitle: 'Envoyer ces factures par e-mail',
      emailToYou: 'Elles vous seront envoyées à',
      alsoSendTo: 'Envoyer également à (facultatif)',
      alsoSendHint: 'p. ex. votre comptable',
      sending: 'Envoi…',
      send: 'Envoyer',
      cancel: 'Annuler',
      emailFailed: "Impossible d'envoyer ces factures. Veuillez réessayer.",
      emailSent: (n: number, to: string) => `${n} facture(s) envoyée(s) à ${to}`,
      status: (s: string) => ({
        paid: 'Payée',
        pending: 'En attente',
        failed: 'Échouée',
        draft: 'Brouillon',
      }[s.toLowerCase()] ?? s),
    },
  }[lang];
  const userEmail = useMemo(() => getUserEmail(), []);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [emailOpen, setEmailOpen] = useState(false);
  const [alsoTo, setAlsoTo] = useState('');
  const [sending, setSending] = useState(false);
  const [emailNotice, setEmailNotice] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = invoices.length > 0 && selected.size === invoices.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(invoices.map((i) => i.id)));

  const emailJustThis = (id: string) => {
    setSelected(new Set([id]));
    setEmailOpen(true);
  };

  const handleEmail = async () => {
    try {
      setSending(true);
      const res = await emailInvoiceCopies([...selected], alsoTo.trim() || undefined);
      setEmailNotice(c.emailSent(res.invoiceCount, (res.to ?? []).join(', ')));
      setEmailOpen(false);
      setAlsoTo('');
      setSelected(new Set());
    } catch (error) {
      console.error('Failed to email invoices:', error);
      alert(c.emailFailed);
    } finally {
      setSending(false);
    }
  };

  const handleDownload = async (invoice: Invoice) => {
    try {
      setDownloadingId(invoice.id);
      const blob = await downloadInvoicePdf(invoice.id);
      const filename = `${invoice.invoiceNumber ?? `invoice-${invoice.id.slice(0, 8)}`}.pdf`;
      triggerPdfDownload(blob, filename);
    } catch (error) {
      console.error('Failed to download PDF:', error);
      alert(c.downloadFailed);
    } finally {
      setDownloadingId(null);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'paid':
        return 'bg-emerald-50 text-emerald-700 border-emerald-300';
      case 'pending':
        return 'bg-amber-50 text-amber-700 border-amber-300';
      case 'failed':
        return 'bg-red-500/10 text-red-400 border-red-500/20';
      case 'draft':
        return 'bg-slate-500/10 text-slate-500 border-slate-500/20';
      default:
        return 'bg-slate-500/10 text-slate-500 border-slate-500/20';
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  };

  const formatCurrency = (amountInPence: number) => {
    return `£${(amountInPence / 100).toFixed(2)}`;
  };

  if (invoices.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center">
        <div className="text-slate-500">
          <svg
            className="mx-auto mb-4 h-12 w-12 text-slate-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <p className="text-lg font-medium">{c.noInvoices}</p>
          <p className="mt-1 text-sm text-slate-500">{c.noInvoicesHint}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      {emailNotice && (
        <div className="border-b border-emerald-200 bg-emerald-50 px-6 py-3 text-sm text-emerald-800">
          {emailNotice}
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-6 py-3">
          <span className="text-sm font-medium text-slate-700">{c.selected(selected.size)}</span>
          <button
            onClick={() => setEmailOpen(true)}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            {c.emailSelected}
          </button>
        </div>
      )}

      {emailOpen && (
        <div className="border-b border-slate-200 bg-white px-6 py-5">
          <h3 className="text-sm font-semibold text-slate-900">{c.emailTitle}</h3>
          <p className="mt-1 text-sm text-slate-600">
            {c.emailToYou} <strong>{userEmail ?? 'your account email'}</strong>.
          </p>
          <label className="mt-3 block max-w-sm">
            <span className="block text-xs font-medium text-slate-600">{c.alsoSendTo}</span>
            <input
              type="email"
              value={alsoTo}
              onChange={(e) => setAlsoTo(e.target.value)}
              placeholder={c.alsoSendHint}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </label>
          <div className="mt-4 flex gap-2">
            <button
              onClick={handleEmail}
              disabled={sending}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
            >
              {sending ? c.sending : `${c.send} (${selected.size})`}
            </button>
            <button
              onClick={() => setEmailOpen(false)}
              disabled={sending}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {c.cancel}
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-200 bg-white">
              <th scope="col" className="px-6 py-4 text-left">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label={c.selectAll}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                />
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                {c.colInvoice}
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                {c.colBranch}
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                {c.colPeriod}
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                {c.colAmount}
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                {c.colStatus}
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                {c.colDate}
              </th>
              <th className="px-6 py-4 text-right text-xs font-semibold uppercase tracking-wider text-slate-500">
                {c.colActions}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {invoices.map((invoice) => (
              <tr key={invoice.id} className="transition-colors hover:bg-slate-50">
                <td className="px-6 py-4">
                  <input
                    type="checkbox"
                    checked={selected.has(invoice.id)}
                    onChange={() => toggle(invoice.id)}
                    aria-label={invoice.invoiceNumber ?? invoice.id}
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                  />
                </td>
                <td className="px-6 py-4">
                  <span className="font-mono text-sm text-slate-600">
                    {invoice.invoiceNumber ?? invoice.id.slice(0, 8).toUpperCase()}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <span className="text-sm text-slate-600">{invoice.garage.name}</span>
                  {/* One invoice for the group, so say what each branch came to — otherwise the
                      only number they can see is a total they cannot check. */}
                  {invoice.branches && invoice.branches.length > 1 && (
                    <ul className="mt-1 space-y-0.5">
                      {invoice.branches.map((b) => (
                        <li key={b.id} className="text-xs text-slate-500">
                          {b.name} — {formatCurrency(b.total)}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="px-6 py-4">
                  <div className="text-sm text-slate-500">
                    <div>{formatDate(invoice.periodStart)}</div>
                    <div className="text-xs text-slate-500">{c.periodTo} {formatDate(invoice.periodEnd)}</div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className="text-sm font-semibold text-slate-700">
                    {formatCurrency(invoice.total)}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <span
                    className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${getStatusColor(invoice.status)}`}
                  >
                    {c.status(invoice.status)}
                  </span>
                  {/* A pending Direct Debit is money already on its way, not a missed payment.
                      Saying when it collects is the difference between "you owe us" and "this is
                      in hand" — and it is the question that gets asked most about a pending row. */}
                  {invoice.status?.toLowerCase() === 'pending' && invoice.gocardlessChargeDate && (
                    <div className="mt-1 text-xs text-slate-500">
                      {c.collectsOn} {formatDate(invoice.gocardlessChargeDate)}
                    </div>
                  )}
                  {/* Once it has been taken, say when. Prefer the GoCardless charge date — that
                      is the day the money actually left the account — and fall back to when we
                      marked it paid, which is all we have for older invoices. */}
                  {invoice.status?.toLowerCase() === 'paid' && (invoice.gocardlessChargeDate || invoice.paidAt) && (
                    <div className="mt-1 text-xs text-slate-500">
                      {c.collectedOn} {formatDate(invoice.gocardlessChargeDate || invoice.paidAt!)}
                    </div>
                  )}
                </td>
                <td className="px-6 py-4">
                  <span className="text-sm text-slate-500">{formatDate(invoice.createdAt)}</span>
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => handleDownload(invoice)}
                    disabled={downloadingId === invoice.id}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                  >
                    {downloadingId === invoice.id ? (
                      <>
                        <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                          />
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          />
                        </svg>
                        {c.downloading}
                      </>
                    ) : (
                      <>
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                        {c.downloadPdf}
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => emailJustThis(invoice.id)}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                      />
                    </svg>
                    {c.emailThis}
                  </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
