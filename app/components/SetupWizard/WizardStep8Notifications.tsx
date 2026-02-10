'use client';

import { useState } from 'react';
import { updateAgentConfiguration } from '../../lib/api';
import type { WizardData } from '../SetupWizard';

interface WizardStep8NotificationsProps {
  data: WizardData;
  updateData: (updates: Partial<WizardData>) => void;
  garageId: string;
  onNext: () => void;
  onPrevious: () => void;
}

export default function WizardStep8Notifications({
  data,
  updateData,
  garageId,
  onNext,
  onPrevious,
}: WizardStep8NotificationsProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState('');

  const addEmail = () => {
    if (!newEmail.trim() || data.notificationEmails.length >= 10) return;

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      setError('Please enter a valid email address');
      return;
    }

    if (data.notificationEmails.includes(newEmail.trim())) {
      setError('This email is already added');
      return;
    }

    updateData({ notificationEmails: [...data.notificationEmails, newEmail.trim()] });
    setNewEmail('');
    setError(null);
  };

  const removeEmail = (index: number) => {
    const updated = data.notificationEmails.filter((_, i) => i !== index);
    updateData({ notificationEmails: updated });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (data.notificationEmails.length === 0) {
      setError('Please add at least one email address');
      return;
    }

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
          notificationEmails: data.notificationEmails,
          tonePreference: 'standard',
          allowFastFitOnly: data.allowFastFitOnly,
          enableSmsBookingLinks: data.enableSmsBookingLinks,
        } as any,
        garageId
      );
      onNext();
    } catch (err) {
      console.error('Failed to save notifications:', err);
      setError('Failed to save. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-100">Call Summary Notifications</h2>
        <p className="mt-2 text-slate-400">
          Where should call summaries be sent?
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Email List */}
        {data.notificationEmails.length > 0 && (
          <div className="space-y-2">
            {data.notificationEmails.map((email, index) => (
              <div
                key={index}
                className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800 px-4 py-3"
              >
                <span className="text-slate-300">{email}</span>
                <button
                  type="button"
                  onClick={() => removeEmail(index)}
                  className="text-red-400 transition-colors hover:text-red-300"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add Email */}
        {data.notificationEmails.length < 10 && (
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Add Email Address {data.notificationEmails.length === 0 && <span className="text-red-400">*</span>}
            </label>
            <div className="flex gap-2">
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addEmail())}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                placeholder="email@example.com"
              />
              <button
                type="button"
                onClick={addEmail}
                className="rounded-lg bg-slate-700 px-4 py-2 text-slate-300 transition-colors hover:bg-slate-600"
              >
                Add
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {data.notificationEmails.length}/10 emails added
            </p>
          </div>
        )}

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
              These email addresses will receive summaries of all calls handled by your AI assistant, including bookings and messages.
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
            disabled={isSaving || data.notificationEmails.length === 0}
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
