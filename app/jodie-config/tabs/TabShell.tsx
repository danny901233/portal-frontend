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
 * Standard wrapper for every tab — title + description in header,
 * content card in middle, Save button in footer.
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
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
      <header className="mb-6">
        <h2 className="text-xl font-semibold text-slate-100">{title}</h2>
        <p className="mt-1 text-sm text-slate-400">{description}</p>
      </header>

      <div className="space-y-5">{children}</div>

      <footer className="mt-6 flex items-center justify-end border-t border-slate-800 pt-5">
        <button
          type="button"
          onClick={onSave}
          disabled={isSaving || saveDisabled}
          className="rounded-lg bg-sky-500 px-5 py-2 text-sm font-semibold text-white hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? 'Saving…' : 'Save changes'}
        </button>
      </footer>
    </section>
  );
}
