'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { isReceptionMateStaff } from '../../../lib/auth';
import {
  fetchBillingConfig,
  updateBillingConfig,
  fetchUsage,
} from '../../../lib/api';

export default function GarageBillingConfigPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const garageId = params?.garageId as string;
  const isStaff = isReceptionMateStaff();

  useEffect(() => {
    if (!isStaff) {
      router.replace('/calls');
    }
  }, [isStaff, router]);

  const [config, setConfig] = useState({
    subscriptionCostGbp: 0,
    includedMinutes: 0,
    costPerMinuteGbp: 0,
    vatRate: 0.20,
    trialDays: 0,
    requiresBookingActivation: false,
    bookingsRequiredForActivation: 4,
    hasMessagingAccess: false,
    messagingSubscriptionCostGbp: 0,
    includedMessages: 0,
    costPerMessageGbp: 0,
  });

  const [usageDates, setUsageDates] = useState({
    start: '',
    end: '',
  });

  const [feedback, setFeedback] = useState<string | null>(null);

  const configQuery = useQuery({
    queryKey: ['billing-config', garageId],
    queryFn: () => fetchBillingConfig(garageId),
    enabled: isStaff && !!garageId,
  });

  const usageQuery = useQuery({
    queryKey: ['billing-usage', garageId, usageDates.start, usageDates.end],
    queryFn: () => fetchUsage(garageId, usageDates.start, usageDates.end),
    enabled: isStaff && !!garageId && !!usageDates.start && !!usageDates.end,
  });

  const updateMutation = useMutation({
    mutationFn: (data: typeof config) => updateBillingConfig(garageId, data),
    onSuccess: () => {
      setFeedback('Billing configuration updated successfully');
      queryClient.invalidateQueries({ queryKey: ['billing-config', garageId] });
      queryClient.invalidateQueries({ queryKey: ['adminBusinesses'] });
    },
    onError: (error: any) => {
      setFeedback(`Failed to update: ${error.message}`);
    },
  });

  useEffect(() => {
    if (configQuery.data?.config) {
      const cfg = configQuery.data.config;

      // Calculate trial days if trial end date exists
      let trialDays = 0;
      if (cfg.trialEndDate) {
        const now = new Date();
        const trialEnd = new Date(cfg.trialEndDate);
        if (trialEnd > now) {
          trialDays = Math.ceil((trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        }
      }

      setConfig({
        subscriptionCostGbp: cfg.subscriptionCostGbp,
        includedMinutes: cfg.includedMinutes,
        costPerMinuteGbp: cfg.costPerMinuteGbp,
        vatRate: cfg.vatRate,
        trialDays: trialDays,
        requiresBookingActivation: cfg.requiresBookingActivation,
        bookingsRequiredForActivation: cfg.bookingsRequiredForActivation,
        hasMessagingAccess: cfg.hasMessagingAccess ?? false,
        messagingSubscriptionCostGbp: cfg.messagingSubscriptionCostGbp ?? 0,
        includedMessages: cfg.includedMessages ?? 0,
        costPerMessageGbp: cfg.costPerMessageGbp ?? 0,
      });
    }
  }, [configQuery.data]);

  useEffect(() => {
    // Set default date range to current month
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    setUsageDates({
      start: firstDay.toISOString().split('T')[0],
      end: lastDay.toISOString().split('T')[0],
    });
  }, []);

  if (!isStaff) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-800">
        Access denied - staff only
      </div>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateMutation.mutate(config);
  };

  const formatCurrency = (pence: number) => {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: 'GBP',
    }).format(pence / 100);
  };

  const calculateEstimate = () => {
    if (!usageQuery.data?.billing) return null;

    const billing = usageQuery.data.billing;
    return {
      subscription: formatCurrency(billing.subscriptionAmount),
      minutes: formatCurrency(billing.minutesAmount),
      sms: formatCurrency(billing.smsAmount),
      subtotal: formatCurrency(billing.subtotal),
      vat: formatCurrency(billing.vatAmount),
      total: formatCurrency(billing.total),
    };
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <button
            onClick={() => router.push('/admin')}
            className="text-sm text-slate-500 hover:text-slate-600 mb-2"
          >
            ← Back to Admin
          </button>
          <h1 className="text-2xl font-semibold text-slate-900">
            {configQuery.data?.config.name || 'Loading...'}
          </h1>
          <p className="text-sm text-slate-500">Configure billing settings</p>
        </div>
      </header>

      {feedback && (
        <div className="rounded-lg border border-brand-200 bg-brand-100 px-4 py-3 text-sm text-brand-700">
          {feedback}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Configuration Form */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">Billing Configuration</h2>

          {configQuery.isLoading ? (
            <div className="text-sm text-slate-500">Loading configuration...</div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs text-slate-500 mb-2">
                  Monthly Subscription Cost (£)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={config.subscriptionCostGbp}
                  onChange={(e) =>
                    setConfig({ ...config, subscriptionCostGbp: parseFloat(e.target.value) || 0 })
                  }
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                  required
                />
                <p className="text-xs text-slate-500 mt-1">
                  Fixed monthly cost for this branch
                </p>
              </div>

              <div>
                <label className="block text-xs text-slate-500 mb-2">
                  Included Minutes
                </label>
                <input
                  type="number"
                  min="0"
                  value={config.includedMinutes}
                  onChange={(e) =>
                    setConfig({ ...config, includedMinutes: parseInt(e.target.value) || 0 })
                  }
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                  required
                />
                <p className="text-xs text-slate-500 mt-1">
                  Free minutes included in subscription
                </p>
              </div>

              <div>
                <label className="block text-xs text-slate-500 mb-2">
                  Cost Per Minute (£)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={config.costPerMinuteGbp}
                  onChange={(e) =>
                    setConfig({ ...config, costPerMinuteGbp: parseFloat(e.target.value) || 0 })
                  }
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                  required
                />
                <p className="text-xs text-slate-500 mt-1">
                  Charge per minute after included minutes
                </p>
              </div>

              <div>
                <label className="block text-xs text-slate-500 mb-2">
                  VAT Rate
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={config.vatRate}
                  onChange={(e) =>
                    setConfig({ ...config, vatRate: parseFloat(e.target.value) || 0 })
                  }
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                  required
                />
                <p className="text-xs text-slate-500 mt-1">
                  Enter as decimal (e.g., 0.20 for 20%)
                </p>
              </div>

              <div className="pt-4 border-t border-slate-300 mt-6">
                <h3 className="text-sm font-semibold text-slate-600 mb-4">Messaging (Webchat / WhatsApp)</h3>

                <div className="space-y-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={config.hasMessagingAccess}
                      onChange={(e) =>
                        setConfig({ ...config, hasMessagingAccess: e.target.checked })
                      }
                      className="h-4 w-4 rounded border-slate-300 bg-white text-brand-600"
                    />
                    <span className="text-xs text-slate-500">
                      Messaging access enabled (Connect — webchat, WhatsApp, social)
                    </span>
                  </label>

                  <div>
                    <label className="block text-xs text-slate-500 mb-2">
                      Messaging Subscription Cost (£/mo)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={config.messagingSubscriptionCostGbp}
                      onChange={(e) =>
                        setConfig({ ...config, messagingSubscriptionCostGbp: parseFloat(e.target.value) || 0 })
                      }
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      Fixed monthly messaging fee, billed alongside the voice subscription when access is enabled.
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-500 mb-2">
                      Included Messages
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={config.includedMessages}
                      onChange={(e) =>
                        setConfig({ ...config, includedMessages: parseInt(e.target.value) || 0 })
                      }
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      Free messages included in the messaging subscription
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-500 mb-2">
                      Cost Per Message (£)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={config.costPerMessageGbp}
                      onChange={(e) =>
                        setConfig({ ...config, costPerMessageGbp: parseFloat(e.target.value) || 0 })
                      }
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      Charge per message after included messages
                    </p>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-300 mt-6">
                <h3 className="text-sm font-semibold text-slate-600 mb-4">Trial & Activation</h3>

                <div className="space-y-4">
                  {/* Trial Period */}
                  <div>
                    <label className="block text-xs text-slate-500 mb-2">
                      Free Trial Period (days)
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={config.trialDays}
                      onChange={(e) =>
                        setConfig({ ...config, trialDays: parseInt(e.target.value) || 0 })
                      }
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      Set to 14 for Assist plan. 0 = no trial. All charges (subscription + usage) free during trial.
                    </p>
                    {configQuery.data?.config.trialEndDate && new Date(configQuery.data.config.trialEndDate) > new Date() && (
                      <p className="text-xs text-amber-700 mt-2">
                        Currently in trial until {new Date(configQuery.data.config.trialEndDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                      </p>
                    )}
                  </div>

                  {/* Booking Activation */}
                  <div>
                    <label className="flex items-center gap-2 mb-2">
                      <input
                        type="checkbox"
                        checked={config.requiresBookingActivation}
                        onChange={(e) =>
                          setConfig({ ...config, requiresBookingActivation: e.target.checked })
                        }
                        className="h-4 w-4 rounded border-slate-300 bg-white text-brand-600"
                      />
                      <span className="text-xs text-slate-500">
                        Require confirmed bookings before charging subscription (Automate plan)
                      </span>
                    </label>
                    {config.requiresBookingActivation && (
                      <div className="ml-6 mt-2">
                        <label className="block text-xs text-slate-500 mb-2">
                          Bookings Required
                        </label>
                        <input
                          type="number"
                          min="1"
                          value={config.bookingsRequiredForActivation}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              bookingsRequiredForActivation: parseInt(e.target.value) || 4,
                            })
                          }
                          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                        />
                        <p className="text-xs text-slate-500 mt-1">
                          Usage (minutes/SMS) still charged, but no subscription until this many bookings confirmed.
                        </p>
                        {configQuery.data?.config.requiresBookingActivation && !configQuery.data.config.subscriptionActivatedAt && (
                          <div className="mt-2 rounded-lg bg-brand-100 border border-brand-200 p-3">
                            <p className="text-xs text-brand-700">
                              Current progress: {configQuery.data.config.activationBookingsCount} / {configQuery.data.config.bookingsRequiredForActivation} bookings
                            </p>
                          </div>
                        )}
                        {configQuery.data?.config.subscriptionActivatedAt && (
                          <p className="text-xs text-emerald-700 mt-2">
                            ✓ Subscription activated on {new Date(configQuery.data.config.subscriptionActivatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="pt-4">
                <button
                  type="submit"
                  disabled={updateMutation.isPending}
                  className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                >
                  {updateMutation.isPending ? 'Saving...' : 'Save Configuration'}
                </button>
              </div>
            </form>
          )}
        </section>

        {/* Usage Preview */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">Usage Preview</h2>

          <div className="space-y-4 mb-6">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-2">Start Date</label>
                <input
                  type="date"
                  value={usageDates.start}
                  onChange={(e) => setUsageDates({ ...usageDates, start: e.target.value })}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-2">End Date</label>
                <input
                  type="date"
                  value={usageDates.end}
                  onChange={(e) => setUsageDates({ ...usageDates, end: e.target.value })}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                />
              </div>
            </div>
          </div>

          {usageQuery.isLoading ? (
            <div className="text-sm text-slate-500">Calculating usage...</div>
          ) : usageQuery.data ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-slate-300 bg-slate-50 p-4">
                <h3 className="text-sm font-medium text-slate-600 mb-3">Usage</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Minutes Used</span>
                    <span className="text-slate-900 font-medium">
                      {usageQuery.data.usage.minutesUsed} min
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">SMS Sent</span>
                    <span className="text-slate-900 font-medium">
                      {usageQuery.data.usage.smsCount}
                    </span>
                  </div>
                </div>
              </div>

              {calculateEstimate() && (
                <div className="rounded-lg border border-slate-300 bg-slate-50 p-4">
                  <h3 className="text-sm font-medium text-slate-600 mb-3">Estimated Charges</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Subscription</span>
                      <span className="text-slate-900">{calculateEstimate()!.subscription}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Overage Minutes</span>
                      <span className="text-slate-900">{calculateEstimate()!.minutes}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">SMS</span>
                      <span className="text-slate-900">{calculateEstimate()!.sms}</span>
                    </div>
                    <div className="flex justify-between pt-2 border-t border-slate-300">
                      <span className="text-slate-500">Subtotal</span>
                      <span className="text-slate-900">{calculateEstimate()!.subtotal}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">VAT ({(config.vatRate * 100).toFixed(0)}%)</span>
                      <span className="text-slate-900">{calculateEstimate()!.vat}</span>
                    </div>
                    <div className="flex justify-between pt-2 border-t border-slate-300">
                      <span className="text-slate-600 font-medium">Total</span>
                      <span className="text-slate-900 font-semibold text-base">
                        {calculateEstimate()!.total}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-slate-500">
              Select dates to preview usage and charges
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
