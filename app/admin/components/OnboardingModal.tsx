'use client';

import { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import api from '../../lib/api';

type ExtraBranch = { name: string; googlePlaceId: string | null; twilioNumber?: string };

// One additional branch — its own Google type-ahead + name + per-branch cost.
function BranchRow({ index, value, onChange, onRemove }: {
  index: number;
  value: ExtraBranch;
  onChange: (v: ExtraBranch) => void;
  onRemove: () => void;
}) {
  const [predictions, setPredictions] = useState<{ placeId: string; description: string }[]>([]);
  const [show, setShow] = useState(false);
  const [buying, setBuying] = useState(false);
  const pickedRef = useRef(false);
  useEffect(() => {
    if (pickedRef.current) { pickedRef.current = false; return; }
    const q = value.name.trim();
    if (q.length < 3) { setPredictions([]); return; }
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/admin/places-autocomplete', { params: { q } });
        setPredictions(data.predictions || []);
        setShow(true);
      } catch { setPredictions([]); }
    }, 350);
    return () => clearTimeout(t);
  }, [value.name]);
  const buyNumber = async () => {
    setBuying(true);
    try {
      const { data } = await api.post('/admin/twilio/available-numbers', { countryCode: 'GB', limit: 1 });
      const num = data.numbers?.[0]?.phoneNumber;
      if (num) {
        const res = await api.post('/admin/twilio/purchase', { phoneNumber: num });
        onChange({ ...value, twilioNumber: res.data.phoneNumber });
      }
    } catch { /* leave for manual entry */ }
    finally { setBuying(false); }
  };
  const pick = (p: { placeId: string; description: string }) => {
    pickedRef.current = true;
    const nm = p.description.split(',')[0]?.trim() || p.description;
    onChange({ ...value, name: nm, googlePlaceId: p.placeId });
    setShow(false);
    setPredictions([]);
  };
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-500">Branch {index + 2}</span>
        <button type="button" onClick={onRemove} className="text-xs font-medium text-red-500 hover:underline">Remove</button>
      </div>
      <div className="relative">
        <input
          type="text"
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value, googlePlaceId: null })}
          placeholder="Branch name — or search Google"
          className="w-full rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-900 focus:border-violet-500 focus:outline-none"
        />
        {value.googlePlaceId && <p className="mt-1 text-xs text-emerald-600">✓ Google-linked — details will autofill</p>}
        {show && predictions.length > 0 && (
          <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg">
            {predictions.map((p) => (
              <li key={p.placeId}>
                <button type="button" onClick={() => pick(p)} className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-violet-50">{p.description}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-2 flex items-end gap-2">
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium text-slate-600">Twilio number</label>
          <input
            type="text"
            value={value.twilioNumber ?? ''}
            onChange={(e) => onChange({ ...value, twilioNumber: e.target.value })}
            placeholder="+44… or click Buy new"
            className="w-full rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-900 focus:border-violet-500 focus:outline-none"
          />
        </div>
        <button type="button" onClick={buyNumber} disabled={buying}
          className="rounded-md border border-violet-300 bg-violet-50 px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50">
          {buying ? 'Buying…' : 'Buy new'}
        </button>
      </div>
    </div>
  );
}

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
  // Google Places autofill
  const [googlePlaceId, setGooglePlaceId] = useState<string | null>(null);
  const [placeQuery, setPlaceQuery] = useState('');
  const [predictions, setPredictions] = useState<{ placeId: string; description: string }[]>([]);
  const [showPredictions, setShowPredictions] = useState(false);
  const [placeSearching, setPlaceSearching] = useState(false);
  // Additional branches (multi-branch onboarding) — same business + manager, billed together.
  const [extraBranches, setExtraBranches] = useState<ExtraBranch[]>([]);
  const [userEmail, setUserEmail] = useState('');
  // HighLevel opportunity linking. Staff PICK from candidates we fetch — there's nowhere in the
  // HL UI to copy an opportunity id from, and matching on email alone silently returns the wrong
  // one (customers routinely have several opportunities, and the portal's own contact often has
  // no email on it — the £-bearing opportunity hangs off THAT one).
  const [ghlCandidates, setGhlCandidates] = useState<
    { id: string; name: string; monetaryValue: number | null; contactEmail: string | null }[]
  >([]);
  const [ghlOpportunityId, setGhlOpportunityId] = useState('');
  // Optional: HL contacts created by our own get-started flow have a phone but NO email, so an
  // email-only search misses the opportunity that actually carries the deal value.
  const [ghlSearchPhone, setGhlSearchPhone] = useState('');
  const [ghlSuggestedSource, setGhlSuggestedSource] = useState<string | null>(null);
  // When billing starts. 'mandate' is today's behaviour and stays the default — the other two
  // are free periods the billing engine already supports but the modal never offered.
  const [billingStart, setBillingStart] = useState<'mandate' | 'trial' | 'bookings'>('mandate');
  // Days, not a date: "30" is how these deals are actually agreed, and it saves staff working out
  // what date that lands on. Converted to trialEndDate on submit.
  const [trialDays, setTrialDays] = useState('30');
  const [activationBookings, setActivationBookings] = useState('4');
  // How they pay. Direct Debit is the default and what nearly every customer is on.
  const [paymentMethod, setPaymentMethod] = useState<'directdebit' | 'stripe_card' | 'invoice'>('directdebit');

  const [ghlLoading, setGhlLoading] = useState(false);
  const [ghlSearched, setGhlSearched] = useState(false);
  // Attach to an existing user, or create a new one.
  const [userMode, setUserMode] = useState<'new' | 'existing'>('new');
  const [existingUserId, setExistingUserId] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [showUserResults, setShowUserResults] = useState(false);
  const usersQuery = useQuery({
    queryKey: ['admin-users-for-onboard'],
    queryFn: async () => {
      const { data } = await api.get('/admin/users');
      return (data.users ?? []) as { id: string; email: string }[];
    },
    enabled: isOpen,
  });
  // New business, or add branches to an existing one.
  const [businessMode, setBusinessMode] = useState<'new' | 'existing'>('new');
  const [existingBusinessId, setExistingBusinessId] = useState('');
  const [bizSearch, setBizSearch] = useState('');
  const [showBiz, setShowBiz] = useState(false);
  const businessesQuery = useQuery({
    queryKey: ['admin-businesses-for-onboard'],
    queryFn: async () => {
      const { data } = await api.get('/admin/businesses');
      return ((data.businesses ?? []) as { id: string; name: string; branches?: unknown[] }[])
        .map((b) => ({ id: b.id, name: b.name, branchCount: b.branches?.length ?? 0 }));
    },
    enabled: isOpen && businessMode === 'existing',
  });
  const selectedExistingBiz = (businessesQuery.data ?? []).find((b) => b.id === existingBusinessId);
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
  // Messaging (Connect) pricing — optional; blank = not sold.
  const [messagingSubscription, setMessagingSubscription] = useState('');
  const [includedMessages, setIncludedMessages] = useState('');
  const [costPerMessage, setCostPerMessage] = useState('0.25');
  // Which LiveKit dispatch agent the new garage should be routed to. Default
  // matches the marketing site's self-serve default (RMB-Assist on account 2)
  // so quick-onboard doesn't require a trip into Agent Configurations -> Routing.
  const [agentScript, setAgentScript] = useState<
    'Assist-agent' | 'GarageHive-agent' | 'tyresoft-agent' | 'receptionmate-agent-v3' | 'receptionmate-agent' | 'MMH-agent'
  >('Assist-agent');

  // Service agreement
  const [sendAgreement, setSendAgreement] = useState(true);

  const searchGhl = async () => {
    if (!userEmail && !ghlSearchPhone) return;
    setGhlLoading(true);
    setGhlSearched(true);
    try {
      const qs = new URLSearchParams();
      if (userEmail) qs.set('email', userEmail);
      if (ghlSearchPhone) qs.set('phone', ghlSearchPhone);
      const { data } = await api.get<{
        candidates: typeof ghlCandidates;
        suggestedId: string | null;
        suggestedSource: string | null;
      }>(`/admin/highlevel/opportunities?${qs.toString()}`);
      setGhlCandidates(data.candidates ?? []);
      setGhlSuggestedSource(data.suggestedSource ?? null);
      // Marketing-site leads: we already stored the opportunity when the lead landed, so
      // pre-select it. Only overwrite an untouched selection — never stomp a staff choice.
      if (data.suggestedId && !ghlOpportunityId) setGhlOpportunityId(data.suggestedId);
    } catch {
      setGhlCandidates([]);
      setGhlSuggestedSource(null);
    } finally {
      setGhlLoading(false);
    }
  };

  // Auto-look-up once we have an email and the agreement section is in play. Most deals come from
  // the marketing site, where we already hold the opportunity id — nobody should have to search
  // for something we know.
  useEffect(() => {
    if (!sendAgreement || !userEmail || ghlSearched) return;
    const t = setTimeout(() => void searchGhl(), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendAgreement, userEmail]);

  const [agreementSetupFee, setAgreementSetupFee] = useState('0');
  const [agreementCentres, setAgreementCentres] = useState('1');
  const [agreementLicences, setAgreementLicences] = useState<('assist' | 'automate' | 'connect')[]>(['assist']);
  const [agreementGoLive, setAgreementGoLive] = useState('');

  // Debounced Google Places type-ahead (proxied through the backend — no browser key).
  const placePickedRef = useRef(false);
  useEffect(() => {
    if (placePickedRef.current) { placePickedRef.current = false; return; }
    const q = placeQuery.trim();
    if (q.length < 3) { setPredictions([]); return; }
    setPlaceSearching(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/admin/places-autocomplete', { params: { q } });
        setPredictions(data.predictions || []);
        setShowPredictions(true);
      } catch { setPredictions([]); }
      finally { setPlaceSearching(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [placeQuery]);

  const pickPlace = (p: { placeId: string; description: string }) => {
    placePickedRef.current = true;
    setGooglePlaceId(p.placeId);
    setPlaceQuery(p.description);
    const namePart = p.description.split(',')[0]?.trim() || p.description;
    setBusinessName((prev) => prev || namePart);
    setBranchName((prev) => prev || namePart);
    setShowPredictions(false);
    setPredictions([]);
  };

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
      // One cost per branch applies to every branch; agreement = cost-per-branch × count.
      const validExtra = extraBranches.filter((b) => b.name.trim());
      const totalBranches = 1 + validExtra.length;

      // Existing business: add branches via the batch endpoint (no new business/user); they
      // bill on the business's existing mandate. Optionally raise an updated agreement.
      if (businessMode === 'existing') {
        const branch1Number = useManualEntry ? manualNumber : twilioNumber;
        const allBranches = [
          { name: branchName.trim(), googlePlaceId, twilioNumber: branch1Number },
          ...validExtra.map((b) => ({ name: b.name.trim(), googlePlaceId: b.googlePlaceId, twilioNumber: b.twilioNumber })),
        ].filter((b) => b.name);
        const resp = await api.post(`/admin/businesses/${existingBusinessId}/branches/batch`, {
          userId: existingUserId || undefined,
          branches: allBranches.map((b) => ({
            name: b.name,
            googlePlaceId: b.googlePlaceId || undefined,
            twilioNumber: b.twilioNumber || undefined,
            subscriptionCostGbp: Number(subscriptionCost) || undefined,
            includedMinutes: Number(includedMinutes),
            costPerMinuteGbp: Number(costPerMinute),
            vatRate: Number(vatRatePct) / 100,
            messagingSubscriptionCostGbp: messagingSubscription ? Number(messagingSubscription) : undefined,
            includedMessages: includedMessages ? Number(includedMessages) : undefined,
            costPerMessageGbp: costPerMessage ? Number(costPerMessage) : undefined,
            agentScript,
          })),
        });
        if (sendAgreement && existingUserId) {
          const newTotal = (selectedExistingBiz?.branchCount ?? 0) + allBranches.length;
          const draft = await api.post('/admin/agreements/draft', {
            userId: existingUserId,
            businessId: existingBusinessId,
            clientName: bizSearch.trim(),
            setupFeeGbp: Number(agreementSetupFee) || 0,
            licenceFeeGbp: Number(subscriptionCost),
            centresCount: newTotal,
            licences: agreementLicences,
            goLiveDate: agreementGoLive ? new Date(agreementGoLive).toISOString() : null,
          });
          await api.post(`/admin/agreements/${draft.data.agreement.id}/send`);
        }
        return resp.data;
      }

      const { data } = await api.post('/admin/onboard', {
        businessName,
        branchName,
        twilioNumber: finalNumber || undefined,
        ...(userMode === 'existing' && existingUserId ? { existingUserId } : { userEmail }),
        userRole: 'MANAGER', // first user for a business is its manager (billing + team + branches)
        subscriptionCostGbp: Number(subscriptionCost),
        includedMinutes: Number(includedMinutes),
        costPerMinuteGbp: Number(costPerMinute),
        vatRate: Number(vatRatePct) / 100,
        messagingSubscriptionCostGbp: messagingSubscription ? Number(messagingSubscription) : undefined,
        includedMessages: includedMessages ? Number(includedMessages) : undefined,
        costPerMessageGbp: costPerMessage ? Number(costPerMessage) : undefined,
        agentScript,
        googlePlaceId: googlePlaceId || undefined,
        // Sending an agreement means this is a sales-led deal: create the account but DON'T email
        // the customer their login yet. They get invited from the onboarding pipeline once the
        // agreement is signed and we've built the agent (which needs credentials we fetch from
        // GarageHive/Tyresoft by hand). The invite mints a fresh password at that point.
        deferWelcomeEmail: sendAgreement,
        ghlOpportunityId: ghlOpportunityId || undefined,
        billingMethod: paymentMethod,
        ...(billingStart === 'trial' && Number(trialDays) > 0
          ? { trialDays: Number(trialDays) }
          : {}),
        ...(billingStart === 'bookings'
          ? {
              requiresBookingActivation: true,
              bookingsRequiredForActivation: Number(activationBookings) || 4,
            }
          : {}),
      });

      if (sendAgreement) {
        const draft = await api.post('/admin/agreements/draft', {
          userId: data.user.id,
          businessId: data.business.id,
          clientName: businessName.trim(),
          setupFeeGbp: Number(agreementSetupFee) || 0,
          licenceFeeGbp: Number(subscriptionCost),
          centresCount: validExtra.length > 0 ? totalBranches : (Number(agreementCentres) || 1),
          licences: agreementLicences,
          goLiveDate: agreementGoLive ? new Date(agreementGoLive).toISOString() : null,
        });
        await api.post(`/admin/agreements/${draft.data.agreement.id}/send`);
      }

      // Multi-branch: create the extra branches under the SAME business, granting the new
      // manager access to each so they bill together on the business's mandate.
      if (validExtra.length) {
        await api.post(`/admin/businesses/${data.business.id}/branches/batch`, {
          userId: data.user.id,
          branches: validExtra.map((b) => ({
            name: b.name.trim(),
            googlePlaceId: b.googlePlaceId || undefined,
            twilioNumber: b.twilioNumber || undefined,
            subscriptionCostGbp: Number(subscriptionCost),
            includedMinutes: Number(includedMinutes),
            costPerMinuteGbp: Number(costPerMinute),
            vatRate: Number(vatRatePct) / 100,
            messagingSubscriptionCostGbp: messagingSubscription ? Number(messagingSubscription) : undefined,
            includedMessages: includedMessages ? Number(includedMessages) : undefined,
            costPerMessageGbp: costPerMessage ? Number(costPerMessage) : undefined,
            agentScript,
          })),
        });
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
    setUserMode('new');
    setExistingUserId('');
    setUserSearch('');
    setShowUserResults(false);
    setBusinessMode('new');
    setExistingBusinessId('');
    setBizSearch('');
    setShowBiz(false);
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
    setExtraBranches([]);
    setPlaceQuery('');
    setGooglePlaceId(null);
    setMessagingSubscription('');
    setIncludedMessages('');
    setCostPerMessage('0.25');
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

    const missingBusiness = businessMode === 'new' ? !businessName.trim() : !existingBusinessId;
    const missingUser = businessMode === 'existing' ? !existingUserId : (userMode === 'new' ? !userEmail.trim() : !existingUserId);
    if (missingBusiness || !branchName.trim() || missingUser) {
      setError(businessMode === 'existing' ? 'Select the business, a branch name, and the user to grant access.' : 'Please fill in all required fields');
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
          {step === 'form' && (businessMode === 'existing' ? 'Add Branches' : 'Onboard New Business')}
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
            {/* New business, or add branches to an existing one */}
            <div className="inline-flex rounded-md border border-slate-300 p-0.5 text-sm">
              <button type="button" onClick={() => setBusinessMode('new')}
                className={`rounded px-3 py-1 font-medium ${businessMode === 'new' ? 'bg-violet-600 text-white' : 'text-slate-600'}`}>New business</button>
              <button type="button" onClick={() => { setBusinessMode('existing'); setUserMode('existing'); }}
                className={`rounded px-3 py-1 font-medium ${businessMode === 'existing' ? 'bg-violet-600 text-white' : 'text-slate-600'}`}>Existing business</button>
            </div>
            {businessMode === 'existing' && (
              <div className="relative">
                <label className="block text-sm font-medium text-slate-600 mb-1">Business *</label>
                <input
                  type="text"
                  value={bizSearch}
                  onChange={(e) => { setExistingBusinessId(''); setBizSearch(e.target.value); setShowBiz(true); }}
                  onFocus={() => setShowBiz(true)}
                  placeholder="Search existing businesses…"
                  className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                />
                {existingBusinessId && <p className="mt-1 text-xs text-emerald-600">✓ New branches are added to this business &amp; bill on its existing mandate{selectedExistingBiz ? ` (currently ${selectedExistingBiz.branchCount} branch${selectedExistingBiz.branchCount === 1 ? '' : 'es'})` : ''}.</p>}
                {showBiz && bizSearch.trim() && !existingBusinessId && (
                  <ul className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
                    {(() => {
                      const m = (businessesQuery.data ?? []).filter((b) => b.name.toLowerCase().includes(bizSearch.trim().toLowerCase()));
                      if (!m.length) return <li className="px-3 py-2 text-sm text-slate-400">No matching businesses</li>;
                      return m.slice(0, 8).map((b) => (
                        <li key={b.id}>
                          <button type="button" onClick={() => { setExistingBusinessId(b.id); setBizSearch(b.name); setShowBiz(false); }}
                            className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-violet-50">{b.name} <span className="text-slate-400">· {b.branchCount} branch{b.branchCount === 1 ? '' : 'es'}</span></button>
                        </li>
                      ));
                    })()}
                  </ul>
                )}
              </div>
            )}
            {/* Find on Google — autofills address, phone, hours, greeting & FAQs */}
            <div className="relative">
              <label className="block text-sm font-medium text-slate-600 mb-1">
                Find on Google <span className="font-normal text-slate-400">— autofills the agent config</span>
              </label>
              <input
                type="text"
                value={placeQuery}
                onChange={(e) => { setGooglePlaceId(null); setPlaceQuery(e.target.value); }}
                onFocus={() => predictions.length > 0 && setShowPredictions(true)}
                className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                placeholder="Search the garage's name on Google…"
              />
              {googlePlaceId && (
                <p className="mt-1 text-xs text-emerald-600">✓ Linked — address, phone, opening hours &amp; FAQs will be pulled from Google.</p>
              )}
              {placeSearching && !googlePlaceId && <p className="mt-1 text-xs text-slate-400">Searching…</p>}
              {showPredictions && predictions.length > 0 && (
                <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg">
                  {predictions.map((p) => (
                    <li key={p.placeId}>
                      <button
                        type="button"
                        onClick={() => pickPlace(p)}
                        className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-violet-50"
                      >
                        {p.description}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {businessMode === 'new' && (
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
            )}

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

              <div className="mb-3 inline-flex rounded-md border border-slate-300 p-0.5 text-sm">
                <button type="button" onClick={() => setUserMode('new')}
                  className={`rounded px-3 py-1 font-medium ${userMode === 'new' ? 'bg-violet-600 text-white' : 'text-slate-600'}`}>New user</button>
                <button type="button" onClick={() => setUserMode('existing')}
                  className={`rounded px-3 py-1 font-medium ${userMode === 'existing' ? 'bg-violet-600 text-white' : 'text-slate-600'}`}>Existing user</button>
              </div>

              <div className="space-y-3">
                {userMode === 'new' ? (
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
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      A new manager account is created and login credentials are emailed here.
                    </p>
                  </div>
                ) : (
                  <div className="relative">
                    <label className="block text-sm font-medium text-slate-600 mb-1">
                      Existing user *
                    </label>
                    <input
                      type="text"
                      value={userSearch}
                      onChange={(e) => { setExistingUserId(''); setUserSearch(e.target.value); setShowUserResults(true); }}
                      onFocus={() => setShowUserResults(true)}
                      placeholder="Search users by email…"
                      className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-slate-900 focus:border-violet-500 focus:outline-none"
                    />
                    {existingUserId && <p className="mt-1 text-xs text-emerald-600">✓ Selected</p>}
                    {showUserResults && userSearch.trim() && !existingUserId && (
                      <ul className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
                        {(() => {
                          const matches = (usersQuery.data ?? []).filter((u) => u.email.toLowerCase().includes(userSearch.trim().toLowerCase()));
                          if (matches.length === 0) return <li className="px-3 py-2 text-sm text-slate-400">No matching users</li>;
                          return matches.slice(0, 8).map((u) => (
                            <li key={u.id}>
                              <button
                                type="button"
                                onClick={() => { setExistingUserId(u.id); setUserSearch(u.email); setShowUserResults(false); }}
                                className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-violet-50"
                              >
                                {u.email}
                              </button>
                            </li>
                          ));
                        })()}
                      </ul>
                    )}
                    <p className="mt-1 text-xs text-slate-500">
                      This business is attached to the chosen account (granted manager access). No new login is created.
                    </p>
                  </div>
                )}
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
                    Monthly subscription (£ per branch) *
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

              <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-500 mb-2">Messaging (Connect) — optional</p>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Messaging sub (£/mo)</label>
                    <input type="number" step="0.01" min="0" value={messagingSubscription}
                      onChange={(e) => setMessagingSubscription(e.target.value)}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-violet-500 focus:outline-none"
                      placeholder="0.00" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Included messages</label>
                    <input type="number" step="1" min="0" value={includedMessages}
                      onChange={(e) => setIncludedMessages(e.target.value)}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-violet-500 focus:outline-none"
                      placeholder="500" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Cost per message (£)</label>
                    <input type="number" step="0.01" min="0" value={costPerMessage}
                      onChange={(e) => setCostPerMessage(e.target.value)}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-violet-500 focus:outline-none"
                      placeholder="0.25" />
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-400">Leave the subscription blank if they&rsquo;re not on Connect. Applies to all branches.</p>
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

            {/* Additional branches — multi-branch onboarding */}
            <div className="border-t border-slate-300 pt-4">
              <h3 className="text-sm font-semibold text-slate-600 mb-1">Additional branches</h3>
              <p className="text-xs text-slate-500 mb-3">
                Same business &amp; manager, billed together on one mandate. Every branch uses the monthly subscription above (cost per branch); each just needs its name / Google listing for autofill (address, hours, FAQs).
              </p>
              <div className="space-y-3">
                {extraBranches.map((b, i) => (
                  <BranchRow
                    key={i}
                    index={i}
                    value={b}
                    onChange={(v) => setExtraBranches((prev) => prev.map((x, xi) => (xi === i ? v : x)))}
                    onRemove={() => setExtraBranches((prev) => prev.filter((_, xi) => xi !== i))}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={() => setExtraBranches((prev) => [...prev, { name: '', googlePlaceId: null }])}
                className="mt-3 inline-flex items-center gap-1 rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-700 hover:bg-violet-100"
              >
                + Add another branch
              </button>
            </div>

            <div className="border-t border-slate-300 pt-4">
              <h3 className="mb-1 text-sm font-semibold text-slate-600">How do they pay?</h3>
              <div className="space-y-2">
                {([
                  ['directdebit', 'Direct Debit', 'They set up a GoCardless mandate when they first log in.'],
                  ['stripe_card', 'Card', 'They enter card details when they first log in; Stripe bills monthly.'],
                  ['invoice', 'Invoice', 'We email an invoice and they pay by bank transfer. No payment step at login.'],
                ] as const).map(([key, label, hint]) => (
                  <label key={key} className="flex cursor-pointer items-start gap-2">
                    <input
                      type="radio"
                      name="paymentMethod"
                      checked={paymentMethod === key}
                      onChange={() => setPaymentMethod(key)}
                      className="mt-1 border-slate-300 text-brand-600 focus:ring-brand-600"
                    />
                    <span>
                      <span className="text-sm text-slate-700">{label}</span>
                      <span className="block text-xs text-slate-500">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {paymentMethod === 'invoice' ? (
                <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  They&rsquo;ll never be asked to set up payment in the portal, and won&rsquo;t appear in
                  Direct Debit chasing. Invoicing them is a manual job.
                </p>
              ) : null}
            </div>

            <div className="border-t border-slate-300 pt-4">
              <h3 className="mb-1 text-sm font-semibold text-slate-600">When does billing start?</h3>
              <div className="space-y-2">
                {([
                  ['mandate', 'Bill from when they set up payment', 'Standard. The cycle starts the day they complete payment setup.'],
                  ['trial', 'Free trial until a date', 'Billing starts automatically the day the trial expires.'],
                  ['bookings', 'Free until N confirmed bookings', 'Billing starts on the Nth booking — they only pay once it has demonstrably worked.'],
                ] as const).map(([key, label, hint]) => (
                  <label key={key} className="flex cursor-pointer items-start gap-2">
                    <input
                      type="radio"
                      name="billingStart"
                      checked={billingStart === key}
                      onChange={() => setBillingStart(key)}
                      className="mt-1 border-slate-300 text-brand-600 focus:ring-brand-600"
                    />
                    <span>
                      <span className="text-sm text-slate-700">{label}</span>
                      <span className="block text-xs text-slate-500">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>

              {billingStart === 'trial' ? (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    max="365"
                    value={trialDays}
                    onChange={(e) => setTrialDays(e.target.value)}
                    className="w-20 rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-900"
                  />
                  <span className="text-xs text-slate-500">
                    days free
                    {Number(trialDays) > 0
                      ? ` — billing starts ${new Date(Date.now() + Number(trialDays) * 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`
                      : ''}
                  </span>
                </div>
              ) : null}
              {billingStart === 'bookings' ? (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={activationBookings}
                    onChange={(e) => setActivationBookings(e.target.value)}
                    className="w-20 rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-900"
                  />
                  <span className="text-xs text-slate-500">confirmed bookings before billing starts</span>
                </div>
              ) : null}

              {billingStart !== 'mandate' && paymentMethod !== 'invoice' ? (
                <p className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  They&rsquo;ll still set up their{' '}
                  {paymentMethod === 'stripe_card' ? 'card' : 'Direct Debit'} at sign-in — nothing is
                  collected until the free period ends.
                </p>
              ) : null}
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
                <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <strong>The customer will NOT get their login yet.</strong> The account is created
                  silently and the deal enters the onboarding pipeline. Once the agreement is signed
                  and you&rsquo;ve built the agent, invite them from{' '}
                  <span className="font-medium">Admin &rsaquo; Agreements &rsaquo; Pipeline</span> —
                  that&rsquo;s what emails their login.
                </p>
              )}

              {sendAgreement && (
                <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-slate-600">HighLevel opportunity</label>
                    <button
                      type="button"
                      onClick={() => void searchGhl()}
                      disabled={ghlLoading || (!userEmail && !ghlSearchPhone)}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                    >
                      {ghlLoading ? 'Searching…' : 'Find opportunities'}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Link the opportunity your team is already working, so the portal can move it
                    through the pipeline as the deal progresses. We never create a new one.
                  </p>
                  <input
                    type="tel"
                    value={ghlSearchPhone}
                    onChange={(e) => setGhlSearchPhone(e.target.value)}
                    placeholder="Also search by phone (optional) — finds contacts with no email"
                    className="mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                  />
                  {ghlSuggestedSource && ghlOpportunityId ? (
                    <p className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
                      Matched automatically from {ghlSuggestedSource} — change it below if that&rsquo;s wrong.
                    </p>
                  ) : null}
                  {ghlSearched && !ghlLoading ? (
                    ghlCandidates.length ? (
                      <select
                        value={ghlOpportunityId}
                        onChange={(e) => setGhlOpportunityId(e.target.value)}
                        className="mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                      >
                        <option value="">Don&rsquo;t link an opportunity</option>
                        {ghlCandidates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                            {typeof c.monetaryValue === 'number' ? ` — £${c.monetaryValue}` : ''}
                            {c.contactEmail ? ` (${c.contactEmail})` : ' (no email on contact)'}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="mt-2 text-xs text-amber-700">
                        No opportunities found for that email/phone. You can link it later from the
                        onboarding pipeline.
                      </p>
                    )
                  ) : null}
                </div>
              )}

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
