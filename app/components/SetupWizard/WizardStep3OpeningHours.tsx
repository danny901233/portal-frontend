'use client';

import { useState } from 'react';
import { updateAgentConfiguration } from '../../lib/api';
import type { WizardData } from '../SetupWizard';

const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const dayLabels: Record<string, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

interface WizardStep3OpeningHoursProps {
  data: WizardData;
  updateData: (updates: Partial<WizardData>) => void;
  garageId: string;
  onNext: () => void;
  onPrevious: () => void;
}

export default function WizardStep3OpeningHours({
  data,
  updateData,
  garageId,
  onNext,
  onPrevious,
}: WizardStep3OpeningHoursProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hours = data.weeklyOpeningHours || {};

  const updateDayHours = (day: string, field: 'open' | 'close' | 'closed', value: string | boolean) => {
    const updated = { ...hours };
    if (!updated[day]) {
      updated[day] = { open: '09:00', close: '17:00', closed: false };
    }

    if (field === 'closed') {
      if (value === false) {
        // When unchecking "closed", ensure we have valid times
        updated[day] = {
          open: updated[day].open || '09:00',
          close: updated[day].close || '17:00',
          closed: false,
        };
      } else {
        // When marking as closed, clear the times
        updated[day] = { open: null, close: null, closed: true };
      }
    } else {
      updated[day] = { ...updated[day], [field]: value };
    }
    updateData({ weeklyOpeningHours: updated });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validation: At least one day must have hours OR holiday closures text
    const hasHours = days.some(day => hours[day] && !hours[day].closed);
    if (!hasHours && !data.holidayClosures.trim()) {
      setError('Please set opening hours for at least one day or add holiday closure information');
      return;
    }

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
      console.error('Failed to save opening hours:', err);
      setError('Failed to save. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-100">Set Your Opening Hours</h2>
        <p className="mt-2 text-slate-400">
          Let customers know when you're available.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Weekly Schedule */}
        <div className="space-y-2">
          {days.map((day) => {
            const dayHours = hours[day] || { open: '09:00', close: '17:00', closed: false };
            return (
              <div
                key={day}
                className="flex items-center gap-4 rounded-lg border border-slate-700 bg-slate-800 p-4"
              >
                <div className="w-28">
                  <span className="font-medium text-slate-300">{dayLabels[day]}</span>
                </div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={dayHours.closed}
                    onChange={(e) => updateDayHours(day, 'closed', e.target.checked)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-700 text-blue-600"
                  />
                  <span className="text-sm text-slate-400">Closed</span>
                </label>
                {!dayHours.closed && (
                  <div className="flex flex-1 items-center gap-2">
                    <input
                      type="time"
                      value={dayHours.open}
                      onChange={(e) => updateDayHours(day, 'open', e.target.value)}
                      className="rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-200"
                    />
                    <span className="text-slate-500">to</span>
                    <input
                      type="time"
                      value={dayHours.close}
                      onChange={(e) => updateDayHours(day, 'close', e.target.value)}
                      className="rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-200"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Holiday Closures */}
        <div>
          <label htmlFor="holidayClosures" className="block text-sm font-medium text-slate-300">
            Holiday Closures or Special Hours
          </label>
          <textarea
            id="holidayClosures"
            rows={2}
            value={data.holidayClosures}
            onChange={(e) => updateData({ holidayClosures: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="e.g., Closed Christmas Day and Boxing Day"
          />
        </div>

        {/* Info */}
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4">
          <div className="flex gap-3">
            <svg
              className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p className="text-sm text-blue-300">
              Your agent will still answer calls outside these hours, but will inform callers that you're currently closed.
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
