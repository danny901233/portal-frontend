'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { isReceptionMateStaff } from '../../lib/auth';
import {
  fetchGarages,
  fetchInvoices,
  chargeInvoice,
  fetchUsersDueForBilling,
  processMonthlyBilling,
  fetchUsersPendingBilling,
  activateBilling,
  fetchUsersWithoutMandate,
  requestDirectDebitSetup,
} from '../../lib/api';

export default function BillingDashboardPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [feedback, setFeedback] = useState<string | null>(null);

  // Check if user is staff
  const isStaff = isReceptionMateStaff();

  const garagesQuery = useQuery({
    queryKey: ['garages-billing'],
    queryFn: () => fetchGarages(),
    enabled: isStaff,
  });

  const usersDueQuery = useQuery({
    queryKey: ['users-due-billing'],
    queryFn: () => fetchUsersDueForBilling(),
    enabled: isStaff,
  });

  const pendingBillingQuery = useQuery({
    queryKey: ['users-pending-billing'],
    queryFn: () => fetchUsersPendingBilling(),
    enabled: isStaff,
  });

  const usersWithoutMandateQuery = useQuery({
    queryKey: ['users-without-mandate'],
    queryFn: () => fetchUsersWithoutMandate(),
    enabled: isStaff,
  });

  const invoicesQuery = useQuery({
    queryKey: ['invoices', selectedStatus],
    queryFn: () => fetchInvoices({ status: selectedStatus === 'all' ? undefined : selectedStatus }),
    enabled: isStaff,
  });

  const processMonthlyMutation = useMutation({
    mutationFn: processMonthlyBilling,
    onSuccess: (data) => {
      setFeedback(`Processed ${data.summary.successful} users successfully. ${data.summary.failed} failed.`);
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['users-due-billing'] });
    },
    onError: (error: any) => {
      setFeedback(`Failed to process billing: ${error.message}`);
    },
  });

  const chargeMutation = useMutation({
    mutationFn: chargeInvoice,
    onSuccess: () => {
      setFeedback('Payment created successfully');
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (error: any) => {
      setFeedback(`Failed to create payment: ${error.message}`);
    },
  });

  const activateBillingMutation = useMutation({
    mutationFn: activateBilling,
    onSuccess: (data) => {
      setFeedback(`Billing activated! Charged £${data.chargedAmount} for first month.`);
      queryClient.invalidateQueries({ queryKey: ['users-pending-billing'] });
      queryClient.invalidateQueries({ queryKey: ['users-due-billing'] });
    },
    onError: (error: any) => {
      setFeedback(`Failed to activate billing: ${error.response?.data?.error || error.message}`);
    },
  });

  const requestDirectDebitMutation = useMutation({
    mutationFn: requestDirectDebitSetup,
    onSuccess: (data) => {
      setFeedback(`Direct Debit request email sent successfully!`);
    },
    onError: (error: any) => {
      setFeedback(`Failed to send email: ${error.response?.data?.error || error.message}`);
    },
  });

  if (!isStaff) {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-6 text-sm text-amber-200">
        Access denied - staff only
      </div>
    );
  }

  const handleProcessMonthlyBilling = () => {
    if (confirm(`Process monthly billing for ${usersDueQuery.data?.users.length || 0} users due for billing?`)) {
      processMonthlyMutation.mutate();
    }
  };

  const handleChargeInvoice = (invoiceId: string) => {
    if (confirm('Create GoCardless payment for this invoice?')) {
      chargeMutation.mutate(invoiceId);
    }
  };

  const handleActivateBilling = (userId: string, email: string, amount: number) => {
    if (confirm(`Activate billing for ${email}?\n\nThis will:\n- Set billing start date to today\n- Charge £${amount} for the first month\n- Enable monthly recurring billing`)) {
      activateBillingMutation.mutate(userId);
    }
  };

  const handleRequestDirectDebit = (userId: string, email: string) => {
    if (confirm(`Send Direct Debit setup request to ${email}?\n\nThis will email them a link to set up their Direct Debit mandate.`)) {
      requestDirectDebitMutation.mutate(userId);
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
      month: 'short',
      year: 'numeric',
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

  return (
    <div className="space-y-6">
      <header>
        <button
          onClick={() => router.push('/admin')}
          className="text-sm text-slate-400 hover:text-slate-300 mb-2"
        >
          ← Back to Admin
        </button>
        <h1 className="text-2xl font-semibold text-slate-50">Billing Dashboard</h1>
        <p className="text-sm text-slate-400">
          Manage subscription billing, usage, and invoices
        </p>
      </header>

      {feedback && (
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
          {feedback}
        </div>
      )}

      {/* Users Without Direct Debit Section */}
      {usersWithoutMandateQuery.data?.users && usersWithoutMandateQuery.data.users.length > 0 && (
        <section className="rounded-2xl border border-red-500/40 bg-red-500/10 p-6">
          <h2 className="text-lg font-semibold text-red-100 mb-4">
            ⚠️ No Direct Debit Set Up ({usersWithoutMandateQuery.data.users.length})
          </h2>
          <p className="text-sm text-red-200/80 mb-4">
            These users have garages assigned but haven't set up Direct Debit yet. Send them a request email to complete setup.
          </p>
          <div className="space-y-3">
            {usersWithoutMandateQuery.data.users.map((user: any) => (
              <div
                key={user.id}
                className="rounded-lg border border-red-500/30 bg-slate-900/40 p-4"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium text-slate-100">{user.email}</div>
                      <span className="rounded-full border border-slate-600 bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                        {user.role}
                      </span>
                    </div>
                    <div className="mt-2 space-y-1">
                      {user.garages.map((garage: any) => (
                        <div key={garage.id} className="text-xs text-slate-300">
                          • {garage.name} - £{garage.cost}/month
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-slate-400">
                      Created: {formatDate(user.createdAt)}
                    </div>
                  </div>
                  <div className="ml-4 flex flex-col items-end gap-2">
                    <div className="text-right">
                      <div className="text-lg font-semibold text-slate-100">
                        £{user.totalMonthlyCost}
                      </div>
                      <div className="text-xs text-slate-400">per month</div>
                    </div>
                    <button
                      onClick={() => handleRequestDirectDebit(user.id, user.email)}
                      disabled={requestDirectDebitMutation.isPending}
                      className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
                    >
                      {requestDirectDebitMutation.isPending ? (
                        <>
                          <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          Sending...
                        </>
                      ) : (
                        <>
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                          </svg>
                          Request Direct Debit
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Pending Billing Activation Section */}
      {pendingBillingQuery.data?.users && pendingBillingQuery.data.users.length > 0 && (
        <section className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-6">
          <h2 className="text-lg font-semibold text-amber-100 mb-4">
            ⏳ Pending Billing Activation ({pendingBillingQuery.data.users.length})
          </h2>
          <p className="text-sm text-amber-200/80 mb-4">
            These users have set up Direct Debit but billing hasn't started yet. Activate when they're ready to be charged.
          </p>
          <div className="space-y-3">
            {pendingBillingQuery.data.users.map((user: any) => (
              <div
                key={user.id}
                className="rounded-lg border border-amber-500/30 bg-slate-900/40 p-4"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium text-slate-100">{user.email}</div>
                      <span className="rounded-full border border-slate-600 bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                        {user.role}
                      </span>
                    </div>
                    <div className="mt-2 space-y-1">
                      {user.garages.map((garage: any) => (
                        <div key={garage.id} className="text-xs text-slate-300">
                          • {garage.name} - £{garage.cost}/month
                          {garage.inTrial && <span className="text-amber-400"> (In Trial)</span>}
                          {garage.needsActivation && <span className="text-amber-400"> (Needs Activation)</span>}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-slate-400">
                      Mandate ID: {user.mandateId} • Created: {formatDate(user.createdAt)}
                    </div>
                  </div>
                  <div className="ml-4 flex flex-col items-end gap-2">
                    <div className="text-right">
                      <div className="text-lg font-semibold text-slate-100">
                        £{user.totalMonthlyCost}
                      </div>
                      <div className="text-xs text-slate-400">per month</div>
                    </div>
                    {user.canActivateBilling ? (
                      <button
                        onClick={() => handleActivateBilling(user.id, user.email, user.totalMonthlyCost)}
                        disabled={activateBillingMutation.isPending}
                        className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-400 disabled:opacity-60"
                      >
                        {activateBillingMutation.isPending ? 'Activating...' : 'Activate Billing'}
                      </button>
                    ) : (
                      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        Cannot activate yet
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Monthly Billing Section */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-semibold text-slate-100 mb-4">Monthly Billing</h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-300">
                {usersDueQuery.isLoading ? (
                  'Checking for users due...'
                ) : usersDueQuery.data?.users.length === 0 ? (
                  'No users are due for billing today'
                ) : (
                  <>
                    <span className="font-semibold text-slate-100">
                      {usersDueQuery.data?.users.length || 0}
                    </span>{' '}
                    {usersDueQuery.data?.users.length === 1 ? 'user is' : 'users are'} due for billing
                  </>
                )}
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Billing runs monthly from each customer's mandate setup date
              </p>
            </div>
            <button
              onClick={handleProcessMonthlyBilling}
              disabled={processMonthlyMutation.isPending || !usersDueQuery.data?.users.length}
              className="rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-400 disabled:opacity-60"
            >
              {processMonthlyMutation.isPending ? 'Processing...' : 'Process Monthly Billing'}
            </button>
          </div>

          {usersDueQuery.data?.users && usersDueQuery.data.users.length > 0 && (
            <div className="border-t border-slate-700 pt-4">
              <h3 className="text-sm font-medium text-slate-300 mb-3">Users Due for Billing</h3>
              <div className="space-y-2">
                {usersDueQuery.data.users.map((user: any) => (
                  <div
                    key={user.id}
                    className="rounded-lg border border-slate-700 bg-slate-800/50 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium text-slate-100">{user.email}</div>
                        <div className="text-xs text-slate-400 mt-1">
                          {user.garages.length} {user.garages.length === 1 ? 'branch' : 'branches'} •{' '}
                          Next billing: {formatDate(user.nextBillingDate)}
                        </div>
                      </div>
                      <div className="text-right">
                        {user.garages.map((garage: any) => (
                          <div key={garage.id} className="text-xs text-slate-300">
                            {garage.name}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Garages Section */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-semibold text-slate-100 mb-4">Garages</h2>
        {garagesQuery.isLoading ? (
          <div className="text-sm text-slate-400">Loading garages...</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {garagesQuery.data?.garages.map((garage) => (
              <div
                key={garage.id}
                className="rounded-lg border border-slate-700 bg-slate-800/50 p-4 cursor-pointer hover:border-slate-600 transition"
                onClick={() => router.push(`/admin/billing/${garage.id}`)}
              >
                <div className="font-medium text-slate-100">{garage.name}</div>
                <div className="text-xs text-slate-400 mt-1">Click to configure billing</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Invoices Section */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-slate-100">Invoices</h2>
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          >
            <option value="all">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="pending">Pending</option>
            <option value="paid">Paid</option>
            <option value="failed">Failed</option>
          </select>
        </div>

        {invoicesQuery.isLoading ? (
          <div className="text-sm text-slate-400">Loading invoices...</div>
        ) : invoicesQuery.data?.invoices.length === 0 ? (
          <div className="text-sm text-slate-400 text-center py-8">
            No invoices found. Generate invoices to get started.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-700">
                <tr className="text-left text-xs text-slate-400">
                  <th className="pb-3 font-medium">Garage</th>
                  <th className="pb-3 font-medium">Period</th>
                  <th className="pb-3 font-medium">Usage</th>
                  <th className="pb-3 font-medium">Total</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {invoicesQuery.data?.invoices.map((invoice) => (
                  <tr
                    key={invoice.id}
                    className="border-b border-slate-800 hover:bg-slate-800/30 cursor-pointer"
                    onClick={() => router.push(`/admin/billing/invoices/${invoice.id}`)}
                  >
                    <td className="py-3 text-slate-100">
                      {invoice.garage?.name || invoice.garageId}
                    </td>
                    <td className="py-3 text-slate-300">
                      {formatDate(invoice.periodStart)} - {formatDate(invoice.periodEnd)}
                    </td>
                    <td className="py-3 text-slate-300">
                      {invoice.minutesUsed}min, {invoice.smsCount} SMS
                    </td>
                    <td className="py-3 text-slate-100 font-medium">
                      {formatCurrency(invoice.total)}
                    </td>
                    <td className="py-3">
                      <span className={`inline-block rounded-full border px-2 py-1 text-xs font-medium ${getStatusColor(invoice.status)}`}>
                        {invoice.status}
                      </span>
                    </td>
                    <td className="py-3">
                      {invoice.status === 'draft' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleChargeInvoice(invoice.id);
                          }}
                          disabled={chargeMutation.isPending}
                          className="text-xs text-sky-400 hover:text-sky-300 disabled:opacity-60"
                        >
                          Charge
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
