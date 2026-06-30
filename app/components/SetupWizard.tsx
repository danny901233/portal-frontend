'use client';

// The old multi-step wizard collected agent-config inline. Now that we have a
// proper /agent-setup section with sectioned tabs and a progress widget, the
// wizard's job is much simpler: greet the customer, point them at /agent-setup
// (or let them skip for later), and mark the wizard dismissed so it doesn't
// keep reappearing.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { completeSetupWizard } from '../lib/onboarding';

interface SetupWizardProps {
  isOpen: boolean;
  garageId: string;
  agentType: 'assist' | 'automate';
  onComplete: () => void;
}

export default function SetupWizard({ isOpen, agentType, onComplete }: SetupWizardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<'start' | 'skip' | null>(null);

  if (!isOpen) return null;

  const dismiss = async () => {
    try {
      await completeSetupWizard();
    } catch (err) {
      console.error('Failed to dismiss setup wizard:', err);
    }
    onComplete();
  };

  const handleStart = async () => {
    setBusy('start');
    await dismiss();
    // Start at step 1 of the guided tour — TourBanner reads ?tour= and shows
    // a friendly hint banner above each setup page.
    router.push('/agent-setup/company-information?tour=1');
  };

  const handleSkip = async () => {
    setBusy('skip');
    await dismiss();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        {/* Brand band */}
        <div className="bg-brand-600 px-6 py-5 text-white">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/15">
              <RocketIcon />
            </span>
            <div>
              <h2 className="text-lg font-semibold">Let&rsquo;s set up your AI agent</h2>
              <p className="text-xs text-brand-100">A few minutes now → fewer missed calls later.</p>
            </div>
          </div>
        </div>

        <div className="px-6 py-6">
          <p className="text-sm text-slate-700">
            Welcome aboard. You&rsquo;ve been provisioned with our <strong>{agentType === 'automate' ? 'Automate' : 'Assist'}</strong> tier.
            From here you can configure how your agent introduces itself, answers FAQs, transfers calls and more.
          </p>

          <ul className="mt-4 space-y-2 text-sm text-slate-600">
            <Bullet>Set your opening hours so the agent knows when you&rsquo;re available</Bullet>
            <Bullet>Pick a voice and preview it before going live</Bullet>
            <Bullet>Add the FAQs and rules that match how you run your business</Bullet>
          </ul>

          <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
            No rush — you can complete each section in any order, and skip the rest for now. The progress widget in the
            sidebar tracks what&rsquo;s done.
          </div>
        </div>

        <div className="flex gap-3 border-t border-slate-200 bg-slate-50 px-6 py-4">
          <button
            type="button"
            onClick={handleSkip}
            disabled={busy !== null}
            className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {busy === 'skip' ? 'Skipping…' : 'Skip for now'}
          </button>
          <button
            type="button"
            onClick={handleStart}
            disabled={busy !== null}
            className="flex-1 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-brand-600/25 hover:bg-brand-700 disabled:opacity-50"
          >
            {busy === 'start' ? 'Opening…' : 'Set up my agent'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-600">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
      <span>{children}</span>
    </li>
  );
}

function RocketIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
    </svg>
  );
}
