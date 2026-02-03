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
  const [userPassword, setUserPassword] = useState('');
  const [twilioNumber, setTwilioNumber] = useState('');
  const [manualNumber, setManualNumber] = useState('');
  const [useManualEntry, setUseManualEntry] = useState(false);
  const [searchAreaCode, setSearchAreaCode] = useState('');
  const [availableNumbers, setAvailableNumbers] = useState<TwilioNumber[]>([]);
  const [selectedNumber, setSelectedNumber] = useState<string | null>(null);
  const [error, setError] = useState('');

  const searchNumbersMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post('/api/admin/twilio/available-numbers', {
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
      const { data } = await api.post('/api/admin/twilio/purchase', {
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
      const { data } = await api.post('/api/admin/onboard', {
        businessName,
        branchName,
        twilioNumber: finalNumber || undefined,
        userEmail,
        userPassword,
        userRole: 'USER',
      });
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
    setUserPassword('');
    setTwilioNumber('');
    setManualNumber('');
    setUseManualEntry(false);
    setSearchAreaCode('');
    setAvailableNumbers([]);
    setSelectedNumber(null);
    setError('');
    setStep('form');
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!businessName.trim() || !branchName.trim() || !userEmail.trim() || !userPassword.trim()) {
      setError('Please fill in all required fields');
      return;
    }

    if (userPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    onboardMutation.mutate();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg bg-slate-900 p-6 shadow-xl">
        <button
          onClick={handleClose}
          className="absolute right-4 top-4 text-slate-400 hover:text-slate-200"
        >
          ✕
        </button>

        <h2 className="mb-6 text-2xl font-bold text-slate-100">
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
              <label className="block text-sm font-medium text-slate-300 mb-1">
                Business Name *
              </label>
              <input
                type="text"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 focus:border-violet-500 focus:outline-none"
                placeholder="Acme Garage Ltd"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">
                Branch Name *
              </label>
              <input
                type="text"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 focus:border-violet-500 focus:outline-none"
                placeholder="Main Branch"
              />
            </div>

            <div className="border-t border-slate-700 pt-4">
              <h3 className="text-sm font-semibold text-slate-300 mb-3">Phone Number</h3>
              
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="useTwilio"
                    checked={!useManualEntry}
                    onChange={() => setUseManualEntry(false)}
                    className="text-violet-500"
                  />
                  <label htmlFor="useTwilio" className="text-sm text-slate-300">
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
                          className="flex-1 rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 focus:border-violet-500 focus:outline-none"
                          placeholder="+447XXXXXXXXX"
                        />
                        <button
                          type="button"
                          onClick={() => setTwilioNumber('')}
                          className="px-3 py-2 text-sm text-slate-400 hover:text-slate-200"
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
                          className="flex-1 rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 focus:border-violet-500 focus:outline-none"
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
                  <label htmlFor="useManual" className="text-sm text-slate-300">
                    Manual entry (for Infinity/SIP customers)
                  </label>
                </div>

                {useManualEntry && (
                  <div className="ml-6">
                    <input
                      type="text"
                      value={manualNumber}
                      onChange={(e) => setManualNumber(e.target.value)}
                      className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 focus:border-violet-500 focus:outline-none"
                      placeholder="+447XXXXXXXXX or leave blank"
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      Leave blank for customers using their own SIP provider
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-slate-700 pt-4">
              <h3 className="text-sm font-semibold text-slate-300 mb-3">User Account</h3>
              
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">
                    Email *
                  </label>
                  <input
                    type="email"
                    value={userEmail}
                    onChange={(e) => setUserEmail(e.target.value)}
                    className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 focus:border-violet-500 focus:outline-none"
                    placeholder="manager@business.com"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">
                    Temporary Password *
                  </label>
                  <input
                    type="password"
                    value={userPassword}
                    onChange={(e) => setUserPassword(e.target.value)}
                    className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 focus:border-violet-500 focus:outline-none"
                    placeholder="Min. 8 characters"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    User will be forced to change password on first login
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-3 pt-4">
              <button
                type="button"
                onClick={handleClose}
                className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={onboardMutation.isPending}
                className="flex-1 px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-md text-sm font-medium transition-colors"
              >
                {onboardMutation.isPending ? 'Creating...' : 'Create Business'}
              </button>
            </div>
          </form>
        )}

        {step === 'search' && (
          <div>
            <p className="mb-4 text-sm text-slate-400">
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
                      : 'border-slate-700 bg-slate-800 hover:border-slate-600'
                  }`}
                >
                  <div className="font-mono text-slate-100">{num.phoneNumber}</div>
                  <div className="text-xs text-slate-400">
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
                className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md text-sm font-medium transition-colors"
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
