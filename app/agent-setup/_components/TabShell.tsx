'use client';

import type { ReactNode } from 'react';

interface Props {
  title: string;
  description: string;
  onSave: () => void;
  isSaving: boolean;
  saveDisabled?: boolean;
  children: ReactNode;
}

/**
 * Standard wrapper for every agent-setup tab. Light theme to match the rest
 * of the portal.
 */
export default function TabShell({
  title,
  description,
  onSave,
  isSaving,
  saveDisabled,
  children,
}: Props) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <header className="mb-6">
        <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
        <p className="mt-1 text-sm text-slate-500">{description}</p>
      </header>

      <div className="space-y-5">{children}</div>

      <footer className="mt-6 flex items-center justify-end border-t border-slate-200 pt-5">
        <button
          type="button"
          onClick={onSave}
          disabled={isSaving || saveDisabled}
          className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? 'Saving…' : 'Save changes'}
        </button>
      </footer>
    </section>
  );
}
