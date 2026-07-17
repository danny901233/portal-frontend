'use client';

import type { Invoice } from '../../lib/billing';
import { downloadInvoicePdf, triggerPdfDownload } from '../../lib/billing';
import { useState } from 'react';
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
      colActions: 'Actions',
      periodTo: 'to',
      downloading: 'Downloading...',
      downloadPdf: 'Download PDF',
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
      colActions: 'Actions',
      periodTo: 'au',
      downloading: 'Téléchargement...',
      downloadPdf: 'Télécharger le PDF',
      status: (s: string) => ({
        paid: 'Payée',
        pending: 'En attente',
        failed: 'Échouée',
        draft: 'Brouillon',
      }[s.toLowerCase()] ?? s),
    },
  }[lang];
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const handleDownload = async (invoice: Invoice) => {
    try {
      setDownloadingId(invoice.id);
      const blob = await downloadInvoicePdf(invoice.id);
      const filename = `invoice-${invoice.id.slice(0, 8)}.pdf`;
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
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-200 bg-white">
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
                  <span className="font-mono text-sm text-slate-600">
                    {invoice.id.slice(0, 8).toUpperCase()}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <span className="text-sm text-slate-600">{invoice.garage.name}</span>
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
                </td>
                <td className="px-6 py-4">
                  <span className="text-sm text-slate-500">{formatDate(invoice.createdAt)}</span>
                </td>
                <td className="px-6 py-4 text-right">
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
