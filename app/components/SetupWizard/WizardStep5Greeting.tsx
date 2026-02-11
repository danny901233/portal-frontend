'use client';

import { useState } from 'react';
import { updateAgentConfiguration } from '../../lib/api';
import type { WizardData } from '../SetupWizard';

interface WizardStep5GreetingProps {
  data: WizardData;
  updateData: (updates: Partial<WizardData>) => void;
  garageId: string;
  branchName: string;
  onNext: () => void;
  onPrevious: () => void;
}

export default function WizardStep5Greeting({
  data,
  updateData,
  garageId,
  branchName,
  onNext,
  onPrevious,
}: WizardStep5GreetingProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const placeholder = `Hello! Thank you for calling ${branchName || 'our garage'}. How can I help you today?`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSaving(true);

    try {
      await updateAgentConfiguration(
        {
          branchName: data.branchName || '',
          phoneNumber: data.phoneNumber || '',
          emailAddress: data.emailAddress || '',
          branchAddress: data.branchAddress || '',
          websiteUrl: data.websiteUrl || '',
          weeklyOpeningHours: data.weeklyOpeningHours,
          holidayClosures: data.holidayClosures || '',
          greetingLine: data.greetingLine || '',
          voice: data.voice || 'leah',
          notificationEmails: data.notificationEmails || [],
          tonePreference: 'standard',
          allowFastFitOnly: data.allowFastFitOnly,
          enableSmsBookingLinks: data.enableSmsBookingLinks,
        } as any,
        garageId
      );
      onNext();
    } catch (err) {
      console.error('Failed to save greeting:', err);
      setError('Failed to save. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-100">Set Your Greeting Message</h2>
        <p className="mt-2 text-slate-400">
          This is what your AI assistant will say when answering calls.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="greeting" className="block text-sm font-medium text-slate-300">
            Greeting Message
          </label>
          <textarea
            id="greeting"
            rows={3}
            maxLength={500}
            value={data.greetingLine}
            onChange={(e) => updateData({ greetingLine: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder={placeholder}
          />
          <p className="mt-1 text-xs text-slate-500">
            {data.greetingLine.length}/500 characters
          </p>
          <div className="mt-2 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
            <p className="text-sm text-blue-300">
              <strong>Tip:</strong> Use <code className="rounded bg-blue-500/20 px-1.5 py-0.5 font-mono text-xs">{'{timeofday}'}</code> in your greeting to automatically say "Good morning", "Good afternoon", or "Good evening" based on the time of the call.
            </p>
            <p className="mt-1 text-xs text-blue-400">
              Example: "Good {'{timeofday}'}, thank you for calling Receptionmate"
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

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
            disabled={isSaving}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Next'}
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
