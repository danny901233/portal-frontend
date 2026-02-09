'use client';

import { useState } from 'react';
import { updateAgentConfiguration } from '../../lib/api';
import type { WizardData } from '../SetupWizard';

interface WizardStep2BranchDetailsProps {
  data: WizardData;
  updateData: (updates: Partial<WizardData>) => void;
  garageId: string;
  onNext: () => void;
  onPrevious: () => void;
}

export default function WizardStep2BranchDetails({
  data,
  updateData,
  garageId,
  onNext,
  onPrevious,
}: WizardStep2BranchDetailsProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validation
    if (!data.branchName.trim()) {
      setError('Branch name is required');
      return;
    }

    setIsSaving(true);
    try {
      // Save to backend
      await updateAgentConfiguration(
        {
          branchName: data.branchName,
          phoneNumber: data.phoneNumber || null,
          emailAddress: data.emailAddress || null,
          branchAddress: data.branchAddress || null,
          websiteUrl: data.websiteUrl || null,
          // Include required fields with defaults
          tonePreference: 'standard',
          allowFastFitOnly: false,
        } as any,
        garageId
      );
      onNext();
    } catch (err) {
      console.error('Failed to save branch details:', err);
      setError('Failed to save. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Heading */}
      <div>
        <h2 className="text-2xl font-bold text-slate-100">Confirm Your Branch Details</h2>
        <p className="mt-2 text-slate-400">
          Let's make sure we have the correct information about your branch.
        </p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Branch Name */}
        <div>
          <label htmlFor="branchName" className="block text-sm font-medium text-slate-300">
            Branch Name <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            id="branchName"
            value={data.branchName}
            onChange={(e) => updateData({ branchName: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="e.g., Main Street Garage"
            required
          />
        </div>

        {/* Phone Number */}
        <div>
          <label htmlFor="phoneNumber" className="block text-sm font-medium text-slate-300">
            Phone Number
          </label>
          <input
            type="tel"
            id="phoneNumber"
            value={data.phoneNumber}
            onChange={(e) => updateData({ phoneNumber: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="e.g., 01234 567890"
          />
        </div>

        {/* Email Address */}
        <div>
          <label htmlFor="emailAddress" className="block text-sm font-medium text-slate-300">
            Email Address
          </label>
          <input
            type="email"
            id="emailAddress"
            value={data.emailAddress}
            onChange={(e) => updateData({ emailAddress: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="e.g., info@yourgarage.co.uk"
          />
        </div>

        {/* Branch Address */}
        <div>
          <label htmlFor="branchAddress" className="block text-sm font-medium text-slate-300">
            Branch Address
          </label>
          <textarea
            id="branchAddress"
            rows={2}
            value={data.branchAddress}
            onChange={(e) => updateData({ branchAddress: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="e.g., 123 Main Street, London, SW1A 1AA"
          />
        </div>

        {/* Website URL */}
        <div>
          <label htmlFor="websiteUrl" className="block text-sm font-medium text-slate-300">
            Website URL
          </label>
          <input
            type="url"
            id="websiteUrl"
            value={data.websiteUrl}
            onChange={(e) => updateData({ websiteUrl: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="e.g., https://yourgarage.co.uk"
          />
        </div>

        {/* Error Message */}
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Buttons */}
        <div className="flex justify-between pt-4">
          <button
            type="button"
            onClick={onPrevious}
            disabled={isSaving}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-6 py-3 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Previous
          </button>
          <button
            type="submit"
            disabled={isSaving || !data.branchName.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isSaving && (
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
            )}
            {isSaving ? 'Saving...' : 'Next'}
            {!isSaving && (
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
