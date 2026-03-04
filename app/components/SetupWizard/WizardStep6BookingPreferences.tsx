'use client';

import { useState } from 'react';
import { updateAgentConfiguration } from '../../lib/api';
import type { WizardData } from '../SetupWizard';

interface WizardStep6BookingPreferencesProps {
  data: WizardData;
  updateData: (updates: Partial<WizardData>) => void;
  garageId: string;
  onNext: () => void;
  onPrevious: () => void;
}

export default function WizardStep6BookingPreferences({
  data,
  updateData,
  garageId,
  onNext,
  onPrevious,
}: WizardStep6BookingPreferencesProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      console.error('Failed to save booking preferences:', err);
      setError('Failed to save. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-100">Booking Preferences</h2>
        <p className="mt-2 text-slate-400">
          Choose which types of bookings your AI assistant can accept.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-3">
          <label
            className={`flex cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors ${
              !data.allowFastFitOnly
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-slate-700 bg-slate-800 hover:border-slate-600'
            }`}
          >
            <input
              type="radio"
              name="bookingType"
              checked={!data.allowFastFitOnly}
              onChange={() => updateData({ allowFastFitOnly: false })}
              className="mt-1 h-4 w-4 text-blue-600"
            />
            <div className="flex-1">
              <div className="font-medium text-slate-200">Accept All Booking Types</div>
              <div className="mt-1 text-sm text-slate-400">
                Your AI assistant will accept all types of service bookings, including MOTs, diagnostics, servicing, and repairs.
              </div>
            </div>
          </label>

          <label
            className={`flex cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors ${
              data.allowFastFitOnly
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-slate-700 bg-slate-800 hover:border-slate-600'
            }`}
          >
            <input
              type="radio"
              name="bookingType"
              checked={data.allowFastFitOnly}
              onChange={() => updateData({ allowFastFitOnly: true })}
              className="mt-1 h-4 w-4 text-blue-600"
            />
            <div className="flex-1">
              <div className="font-medium text-slate-200">Fast Fit Services Only</div>
              <div className="mt-1 text-sm text-slate-400">
                Only accept fast fit services (tyres, brakes, exhausts, batteries). For other requests, the AI will take details for a callback.
              </div>
            </div>
          </label>
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
