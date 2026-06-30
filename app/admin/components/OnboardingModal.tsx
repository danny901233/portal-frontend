'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import api from '../../lib/api';

type TwilioNumber = {
  phoneNumber: string;
  friendlyName: string;
  locality: string;
  region: string;
};

type OnboardingModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

export function OnboardingModal({ isOpen, onClose, onSuccess }: OnboardingModalProps) {
  const [step, setStep] = useState<'form' | 'search' | 'purchase'>('form');
  const [businessName, setBusinessName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [twilioNumber, setTwilioNumber] = useState('');
  const [manualNumber, setManualNumber] = useState('');
  const [useManualEntry, setUseManualEntry] = useState(false);
  const [searchAreaCode, setSearchAreaCode] = useState('');
  const [availableNumbers, setAvailableNumbers] = useState<TwilioNumber[]>([]);
  const [selectedNumber, setSelectedNumber] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [subscriptionCost, setSubscriptionCost] = useState('');
  const [includedMinutes, setIncludedMinutes] = useState('400');
  const [costPerMinute, setCostPerMinute] = useState('0.25');
  const [vatRatePct, setVatRatePct] = useState('20');
  // Which LiveKit dispatch agent the new garage should be routed to. Default
  // matches the marketing site's self-serve default (RMB-Assist on account 2)
  // so quick-onboard doesn't require a trip into Agent Configurations -> Routing.
  const [agentScript, setAgentScript] = useState<
    'Assist-agent' | 'GarageHive-agent' | 'tyresoft-agent' | 'receptionmate-agent-v3' | 'receptionmate-agent'
  >('Assist-agent');

  // Service agreement
  const [sendAgreement, setSendAgreement] = useState(true);
  const [agreementSetupFee, setAgreementSetupFee] = useState('0');
  const [agreementCentres, setAgreementCentres] = useState('1');
  const [agreementLicences, setAgreementLicences] = useState<('assist' | 'automate' | 'connect')[]>(['assist']);
  const [agreementGoLive, setAgreementGoLive] = useState('');

  const searchNumbersMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post('/admin/twilio/available-numbers', {
        countryCode: 'GB',
        areaCode: searchAreaCode || undefined,
        limit: 20,
      });
      return data;
    },
    onSuccess: (data) => {
      setAvailableNumbers(data.numbers);
      setStep('search');
    },
    onError: () => setError('Failed to search for available numbers'),
  });

  const purchaseNumberMutation = useMutation({
    mutationFn: async (phoneNumber: string) => {
      const { data } = await api.post('/admin/twilio/purchase', {
        phoneNumber,
      });
      return data;
    },
    onSuccess: (data) => {
      setTwilioNumber(data.phoneNumber);
      setStep('form');
      setError('');
    },
    onError: () => setError('Failed to purchase number'),
  });

  const onboardMutation = useMutation({
    mutationFn: async () => {
      const finalNumber = useManualEntry ? manualNumber : twilioNumber;
      const { data } = await api.post('/admin/onboard', {
        businessName,
        branchName,
        twilioNumber: finalNumber || undefined,
        userEmail,
        userRole: 'USER',
        subscriptionCostGbp: Number(subscriptionCost),
        includedMinutes: Number(includedMinutes),
        costPerMinuteGbp: Number(costPerMinute),
        vatRate: Number(vatRatePct) / 100,
        agentScript,
      });

      if (sendAgreement) {
        const draft = await api.post('/admin/agreements/draft', {
          userId: data.user.id,
          businessId: data.business.id,
          clientName: businessName.trim(),
          setupFeeGbp: Number(agreementSetupFee) || 0,
          licenceFeeGbp: Number(subscriptionCost),
          centresCount: Number(agreementCentres) || 1,
          licences: agreementLicences,
          goLiveDate: agreementGoLive ? new Date(agreementGoLive).toISOString() : null,
        });
        await api.post(`/admin/agreements/${draft.data.agreement.id}/send`);
      }

      return data;
    },
    onSuccess: () => {
      resetForm();
      onSuccess();
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Onboarding failed'),
  });

  const resetForm = () => {
    setBusinessName('');
    setBranchName('');
    setUserEmail('');
    setTwilioNumber('');
    setManualNumber('');
    setUseManualEntry(false);
    setSearchAreaCode('');
    setAvailableNumbers([]);
    setSelectedNumber(null);
    setError('');
    setSubscriptionCost('');
    setIncludedMinutes('400');
    setCostPerMinute('0.25');
    setVatRatePct('20');
    setSendAgreement(true);
    setAgreementSetupFee('0');
    setAgreementCentres('1');
    setAgreementLicences(['assist']);
    setAgreementGoLive('');
    setStep('form');
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!businessName.trim() || !branchName.trim() || !userEmail.trim()) {
      setError('Please fill in all required fields');
      return;
    }

    const sub = Number(subscriptionCost);
    const mins = Number(includedMinutes);
    const perMin = Number(costPerMinute);
    const vat = Number(vatRatePct);
    if (!Number.isFinite(sub) || sub <= 0) {
      setError('Monthly subscription must be greater than £0 — billing won\'t start otherwise');
      return;
    }
    if (!Number.isFinite(mins) || mins < 0 || !Number.isInteger(mins)) {
      setError('Included minutes must be a whole number (0 or more)');
      return;
    }
    if (!Number.isFinite(perMin) || perMin < 0) {
      setError('Overage cost per minute must be 0 or more');
      return;
    }
    if (!Number.isFinite(vat) || vat < 0 || vat > 100) {
      setError('VAT rate must be between 0 and 100');
      return;
    }

    if (sendAgreement && agreementLicences.length === 0) {
      setError('Pick at least one licence to include on the agreement');
      return;
    }

    onboardMutation.mutate();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg bg-white p-6 shadow-xl">
        <button
          onClick={handleClose}
          className="absolute right-4 top-4 text-slate-500 hover:text-slate-700"
        >
          ✕
        </button>

        <h2 className="mb-6 text-2xl font-bold text-slate-900">
          {step === 'form' && 'Onboard New Business'}
          {step === 'search' && 'Select Phone Number'}
          {step === 'purchase' && 'Purchase Number'}
        </h2>

        {error && (
          <div className="mb-4 rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {step === 'form' && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                Business Name *
              </label>
              <input
                type="text"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                placeholder="Acme Garage Ltd"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                Branch Name *
              </label>
              <input
                type="text"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                placeholder="Main Branch"
              />
            </div>

            <div className="border-t border-slate-300 pt-4">
              <h3 className="text-sm font-semibold text-slate-600 mb-3">Phone Number</h3>
              
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="useTwilio"
                    checked={!useManualEntry}
                    onChange={() => setUseManualEntry(false)}
                    className="text-violet-500"
                  />
                  <label htmlFor="useTwilio" className="text-sm text-slate-600">
                    Use Twilio (buy or existing)
                  </label>
                </div>

                {!useManualEntry && (
                  <div className="ml-6 space-y-2">
                    {twilioNumber ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={twilioNumber}
                          onChange={(e) => setTwilioNumber(e.target.value)}
                          className="flex-1 rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                          placeholder="+447XXXXXXXXX"
                        />
                        <button
                          type="button"
                          onClick={() => setTwilioNumber('')}
                          className="px-3 py-2 text-sm text-slate-500 hover:text-slate-700"
                        >
                          Clear
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={searchAreaCode}
                          onChange={(e) => setSearchAreaCode(e.target.value)}
                          className="flex-1 rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                          placeholder="Area code (optional, e.g., 7392)"
                        />
                        <button
                          type="button"
                          onClick={() => searchNumbersMutation.mutate()}
                          disabled={searchNumbersMutation.isPending}
                          className="px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-md text-sm font-medium transition-colors"
                        >
                          {searchNumbersMutation.isPending ? 'Searching...' : 'Buy Number'}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="useManual"
                    checked={useManualEntry}
                    onChange={() => setUseManualEntry(true)}
                    className="text-violet-500"
                  />
                  <label htmlFor="useManual" className="text-sm text-slate-600">
                    Manual entry (for Infinity/SIP customers)
                  </label>
                </div>

                {useManualEntry && (
                  <div className="ml-6">
                    <input
                      type="text"
                      value={manualNumber}
                      onChange={(e) => setManualNumber(e.target.value)}
                      className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                      placeholder="+447XXXXXXXXX or leave blank"
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      Leave blank for customers using their own SIP provider
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-slate-300 pt-4">
              <h3 className="text-sm font-semibold text-slate-600 mb-3">User Account</h3>
              
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    Email *
                  </label>
                  <input
                    type="email"
                    value={userEmail}
                    onChange={(e) => setUserEmail(e.target.value)}
                    className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                    placeholder="manager@business.com"
                    autoComplete="email"
                    required
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Login credentials will be sent to this email address
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t border-slate-300 pt-4">
              <h3 className="text-sm font-semibold text-slate-600 mb-1">Billing</h3>
              <p className="mb-3 text-xs text-slate-500">
                Required. Set the monthly subscription and call-minute pricing now — leaving them blank means the customer&apos;s first Direct Debit won&apos;t schedule a billing cycle.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    Monthly subscription (£) *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={subscriptionCost}
                    onChange={(e) => setSubscriptionCost(e.target.value)}
                    className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                    placeholder="200.00"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    Included minutes / month *
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={includedMinutes}
                    onChange={(e) => setIncludedMinutes(e.target.value)}
                    className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                    placeholder="400"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    Cost per overage minute (£) *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={costPerMinute}
                    onChange={(e) => setCostPerMinute(e.target.value)}
                    className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                    placeholder="0.25"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    VAT rate (%)
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    max="100"
                    value={vatRatePct}
                    onChange={(e) => setVatRatePct(e.target.value)}
                    className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                    placeholder="20"
                  />
                </div>
              </div>

              <div className="mt-3">
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  Routing — LiveKit agent
                </label>
                <select
                  value={agentScript}
                  onChange={(e) => setAgentScript(e.target.value as typeof agentScript)}
                  className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                >
                  <option value="Assist-agent">RMB-Assist (account 2) — default for Assist tier</option>
                  <option value="GarageHive-agent">RMB-GarageHive (account 2) — Automate / GarageHive booking</option>
                  <option value="tyresoft-agent">Tyresoft Agent — tyre centres</option>
                  <option value="receptionmate-agent-v3">Legacy New Agent (account 1)</option>
                  <option value="receptionmate-agent">Legacy Agent (account 1)</option>
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  Sets the dispatch routing for this garage so you don&rsquo;t need to open Agent Configurations after onboarding.
                </p>
              </div>
            </div>

            <div className="border-t border-slate-300 pt-4">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-sm font-semibold text-slate-600">Service agreement</h3>
                <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={sendAgreement}
                    onChange={(e) => setSendAgreement(e.target.checked)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                  />
                  Email sign link to customer
                </label>
              </div>
              <p className="mb-3 text-xs text-slate-500">
                We&rsquo;ll generate a draft and email the customer a magic-link to sign. Monthly licence fee defaults to the subscription above.
              </p>

              {sendAgreement && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-600 mb-1">Setup fee (£)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={agreementSetupFee}
                      onChange={(e) => setAgreementSetupFee(e.target.value)}
                      className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                      placeholder="0"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-600 mb-1">Number of centres</label>
                    <input
                      type="number"
                      step="1"
                      min="1"
                      value={agreementCentres}
                      onChange={(e) => setAgreementCentres(e.target.value)}
                      className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                      placeholder="1"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-slate-600 mb-1">Licences included</label>
                    <div className="flex flex-wrap gap-3">
                      {(['assist', 'automate', 'connect'] as const).map((tier) => (
                        <label key={tier} className="inline-flex items-center gap-2 text-sm text-slate-700">
                          <input
                            type="checkbox"
                            checked={agreementLicences.includes(tier)}
                            onChange={(e) => {
                              setAgreementLicences((prev) =>
                                e.target.checked ? [...prev, tier] : prev.filter((t) => t !== tier),
                              );
                            }}
                            className="rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                          />
                          <span className="capitalize">{tier}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-slate-600 mb-1">Go-live date (optional)</label>
                    <input
                      type="date"
                      value={agreementGoLive}
                      onChange={(e) => setAgreementGoLive(e.target.value)}
                      className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-4">
              <button
                type="button"
                onClick={handleClose}
                className="flex-1 px-4 py-2 bg-slate-100 hover:bg-slate-700 text-slate-600 rounded-md text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={onboardMutation.isPending}
                className="flex-1 px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-md text-sm font-medium transition-colors"
              >
                {onboardMutation.isPending
                  ? sendAgreement
                    ? 'Creating + sending agreement…'
                    : 'Creating…'
                  : sendAgreement
                  ? 'Create + send agreement'
                  : 'Create business'}
              </button>
            </div>
          </form>
        )}

        {step === 'search' && (
          <div>
            <p className="mb-4 text-sm text-slate-500">
              {availableNumbers.length} available numbers found
            </p>
            
            <div className="space-y-2 mb-6 max-h-96 overflow-y-auto">
              {availableNumbers.map((num) => (
                <button
                  key={num.phoneNumber}
                  onClick={() => setSelectedNumber(num.phoneNumber)}
                  className={`w-full text-left rounded-md border p-3 transition-colors ${
                    selectedNumber === num.phoneNumber
                      ? 'border-violet-500 bg-violet-500/10'
                      : 'border-slate-300 bg-slate-100 hover:border-slate-300'
                  }`}
                >
                  <div className="font-mono text-slate-900">{num.phoneNumber}</div>
                  <div className="text-xs text-slate-500">
                    {num.locality}, {num.region}
                  </div>
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setStep('form');
                  setAvailableNumbers([]);
                  setSelectedNumber(null);
                }}
                className="flex-1 px-4 py-2 bg-slate-100 hover:bg-slate-700 text-slate-600 rounded-md text-sm font-medium transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => selectedNumber && purchaseNumberMutation.mutate(selectedNumber)}
                disabled={!selectedNumber || purchaseNumberMutation.isPending}
                className="flex-1 px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-md text-sm font-medium transition-colors"
              >
                {purchaseNumberMutation.isPending ? 'Purchasing...' : 'Purchase & Use'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
