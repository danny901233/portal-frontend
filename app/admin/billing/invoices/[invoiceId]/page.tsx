'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { isReceptionMateStaff } from '../../../../lib/auth';
import { fetchInvoice, chargeInvoice, deleteInvoice, creditInvoice } from '../../../../lib/api';

export default function InvoiceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const invoiceId = params?.invoiceId as string;

  const [feedback, setFeedback] = useState<string | null>(null);

  const isStaff = isReceptionMateStaff();

  useEffect(() => {
    if (!isStaff) {
      router.replace('/calls');
    }
  }, [isStaff, router]);

  const invoiceQuery = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => fetchInvoice(invoiceId),
    enabled: isStaff && !!invoiceId,
  });

  const chargeMutation = useMutation({
    mutationFn: () => chargeInvoice(invoiceId),
    onSuccess: () => {
      setFeedback('Payment created successfully');
      queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    },
    onError: (error: any) => {
      setFeedback(`Failed to create payment: ${error.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteInvoice(invoiceId),
    onSuccess: () => {
      setFeedback('Invoice deleted successfully');
      router.push('/admin/billing');
    },
    onError: (error: any) => {
      setFeedback(`Failed to delete invoice: ${error.message}`);
    },
  });

  const creditMutation = useMutation({
    mutationFn: (reason: string) => creditInvoice(invoiceId, reason),
    onSuccess: () => {
      setFeedback('Invoice credited successfully');
      queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    },
    onError: (error: any) => {
      setFeedback(`Failed to credit invoice: ${error.message}`);
    },
  });

  if (!isStaff) {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-6 text-sm text-amber-200">
        Access denied - staff only
      </div>
    );
  }

  const handleCharge = () => {
    if (confirm('Create GoCardless payment for this invoice?')) {
      chargeMutation.mutate();
    }
  };

  const handleDelete = () => {
    if (confirm('Are you sure you want to delete this invoice? This action cannot be undone.')) {
      deleteMutation.mutate();
    }
  };

  const handleCredit = () => {
    const reason = prompt('Enter reason for crediting this invoice:');
    if (reason && reason.trim()) {
      creditMutation.mutate(reason.trim());
    }
  };

  const formatCurrency = (pence: number) => {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: 'GBP',
    }).format(pence / 100);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  };

  const formatDateTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'paid':
        return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
      case 'pending':
        return 'text-amber-400 bg-amber-500/10 border-amber-500/30';
      case 'draft':
        return 'text-slate-400 bg-slate-500/10 border-slate-500/30';
      case 'failed':
        return 'text-rose-400 bg-rose-500/10 border-rose-500/30';
      default:
        return 'text-slate-400 bg-slate-500/10 border-slate-500/30';
    }
  };

  const invoice = invoiceQuery.data?.invoice;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <button
            onClick={() => router.push('/admin')}
            className="text-sm text-slate-400 hover:text-slate-300 mb-2"
          >
            ← Back to Admin
          </button>
          <h1 className="text-2xl font-semibold text-slate-50">Invoice Details</h1>
          <p className="text-sm text-slate-400">
            {invoice ? `Invoice ${invoice.id.slice(0, 8)}` : 'Loading...'}
          </p>
        </div>
        {invoice && invoice.status === 'draft' && (
          <button
            onClick={handleCharge}
            disabled={chargeMutation.isPending}
            className="rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-400 disabled:opacity-60"
          >
            {chargeMutation.isPending ? 'Creating Payment...' : 'Charge Invoice'}
          </button>
        )}
      </header>

      {feedback && (
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
          {feedback}
        </div>
      )}

      {invoiceQuery.isLoading ? (
        <div className="text-sm text-slate-400">Loading invoice...</div>
      ) : invoice ? (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Main Invoice Details */}
          <div className="lg:col-span-2 space-y-6">
            {/* Header Info */}
            <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
              <div className="flex items-start justify-between mb-6">
                <div>
                  <h2 className="text-lg font-semibold text-slate-100">
                    {invoice.garage?.name || invoice.garageId}
                  </h2>
                  <p className="text-sm text-slate-400 mt-1">
                    Invoice #{invoice.id.slice(0, 8)}
                  </p>
                </div>
                <span
                  className={`inline-block rounded-full border px-3 py-1 text-xs font-medium ${getStatusColor(
                    invoice.status
                  )}`}
                >
                  {invoice.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-slate-400">Billing Period</span>
                  <div className="text-slate-100 mt-1">
                    {formatDate(invoice.periodStart)} - {formatDate(invoice.periodEnd)}
                  </div>
                </div>
                <div>
                  <span className="text-slate-400">Created</span>
                  <div className="text-slate-100 mt-1">{formatDateTime(invoice.createdAt)}</div>
                </div>
                {invoice.paidAt && (
                  <div>
                    <span className="text-slate-400">Paid</span>
                    <div className="text-slate-100 mt-1">{formatDateTime(invoice.paidAt)}</div>
                  </div>
                )}
                {invoice.gocardlessPaymentId && (
                  <div>
                    <span className="text-slate-400">Payment ID</span>
                    <div className="text-slate-100 mt-1 font-mono text-xs">
                      {invoice.gocardlessPaymentId}
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Usage Details */}
            <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
              <h2 className="text-lg font-semibold text-slate-100 mb-4">Usage Details</h2>

              <div className="space-y-4">
                <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                  <h3 className="text-sm font-medium text-slate-300 mb-3">Call Minutes</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Minutes Used</span>
                      <span className="text-slate-100 font-medium">
                        {invoice.minutesUsed} min
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Included Minutes</span>
                      <span className="text-slate-100">{invoice.minutesIncluded} min</span>
                    </div>
                    <div className="flex justify-between pt-2 border-t border-slate-700">
                      <span className="text-slate-400">Overage Minutes</span>
                      <span className="text-slate-100 font-medium">
                        {Math.max(0, invoice.minutesUsed - invoice.minutesIncluded)} min
                      </span>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                  <h3 className="text-sm font-medium text-slate-300 mb-3">SMS Messages</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Messages Sent</span>
                      <span className="text-slate-100 font-medium">{invoice.smsCount}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Cost per SMS</span>
                      <span className="text-slate-100">£0.99</span>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Billing Rates Used */}
            <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
              <h2 className="text-lg font-semibold text-slate-100 mb-4">Rates Applied</h2>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-slate-400">Subscription Cost</span>
                  <div className="text-slate-100 mt-1">
                    £{invoice.subscriptionCostGbp.toFixed(2)}
                  </div>
                </div>
                <div>
                  <span className="text-slate-400">Cost per Minute</span>
                  <div className="text-slate-100 mt-1">
                    £{invoice.costPerMinuteGbp.toFixed(2)}
                  </div>
                </div>
                <div>
                  <span className="text-slate-400">VAT Rate</span>
                  <div className="text-slate-100 mt-1">
                    {(invoice.vatRate * 100).toFixed(0)}%
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* Charges Summary */}
          <div className="lg:col-span-1">
            <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 sticky top-6">
              <h2 className="text-lg font-semibold text-slate-100 mb-4">Charges</h2>

              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-400">Subscription</span>
                  <span className="text-slate-100">
                    {formatCurrency(invoice.subscriptionAmount)}
                  </span>
                </div>

                <div className="flex justify-between">
                  <span className="text-slate-400">Overage Minutes</span>
                  <span className="text-slate-100">
                    {formatCurrency(invoice.minutesAmount)}
                  </span>
                </div>

                <div className="flex justify-between">
                  <span className="text-slate-400">SMS Messages</span>
                  <span className="text-slate-100">{formatCurrency(invoice.smsAmount)}</span>
                </div>

                <div className="flex justify-between pt-3 border-t border-slate-700">
                  <span className="text-slate-400">Subtotal</span>
                  <span className="text-slate-100">{formatCurrency(invoice.subtotal)}</span>
                </div>

                <div className="flex justify-between">
                  <span className="text-slate-400">
                    VAT ({(invoice.vatRate * 100).toFixed(0)}%)
                  </span>
                  <span className="text-slate-100">{formatCurrency(invoice.vatAmount)}</span>
                </div>

                <div className="flex justify-between pt-3 border-t border-slate-700">
                  <span className="text-slate-300 font-semibold">Total</span>
                  <span className="text-slate-100 font-semibold text-lg">
                    {formatCurrency(invoice.total)}
                  </span>
                </div>
              </div>

              {invoice.status === 'draft' && (
                <div className="mt-6 pt-6 border-t border-slate-700">
                  <button
                    onClick={handleCharge}
                    disabled={chargeMutation.isPending}
                    className="w-full rounded-md bg-sky-500 px-4 py-3 text-sm font-semibold text-white hover:bg-sky-400 disabled:opacity-60"
                  >
                    {chargeMutation.isPending ? 'Creating Payment...' : 'Charge Invoice'}
                  </button>
                  <p className="text-xs text-slate-400 mt-2 text-center">
                    This will create a GoCardless payment
                  </p>
                </div>
              )}

              {invoice.status === 'pending' && (
                <div className="mt-6 pt-6 border-t border-slate-700">
                  <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3">
                    <p className="text-xs text-amber-200">
                      Payment pending - waiting for GoCardless confirmation
                    </p>
                  </div>
                </div>
              )}

              {invoice.status === 'paid' && (
                <div className="mt-6 pt-6 border-t border-slate-700">
                  <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3">
                    <p className="text-xs text-emerald-200">
                      Payment completed on {formatDate(invoice.paidAt!)}
                    </p>
                  </div>
                </div>
              )}

              {invoice.status === 'failed' && (
                <div className="mt-6 pt-6 border-t border-slate-700">
                  <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 p-3">
                    <p className="text-xs text-rose-200">Payment failed</p>
                  </div>
                </div>
              )}

              {invoice.status === 'credited' && (
                <div className="mt-6 pt-6 border-t border-slate-700">
                  <div className="rounded-lg bg-purple-500/10 border border-purple-500/30 p-3">
                    <p className="text-xs text-purple-200">
                      This invoice has been credited
                      {invoice.creditReason && `: ${invoice.creditReason}`}
                    </p>
                  </div>
                </div>
              )}

              {/* Staff Actions */}
              {invoice.status !== 'credited' && (
                <div className="mt-6 pt-6 border-t border-slate-700 space-y-2">
                  <p className="text-xs text-slate-400 mb-3">Staff Actions</p>

                  <button
                    onClick={handleCredit}
                    disabled={creditMutation.isPending}
                    className="w-full rounded-md bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-500 disabled:opacity-60"
                  >
                    {creditMutation.isPending ? 'Crediting...' : 'Credit Invoice'}
                  </button>

                  <button
                    onClick={handleDelete}
                    disabled={deleteMutation.isPending}
                    className="w-full rounded-md border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm font-semibold text-rose-400 hover:bg-rose-500/20 disabled:opacity-60"
                  >
                    {deleteMutation.isPending ? 'Deleting...' : 'Delete Invoice'}
                  </button>
                </div>
              )}
            </section>
          </div>
        </div>
      ) : (
        <div className="text-sm text-slate-400">Invoice not found</div>
      )}
    </div>
  );
}
