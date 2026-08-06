'use client';

import { Loader2 } from 'lucide-react';

type Props = {
  /** When true the bar slides up into view. */
  visible: boolean;
  /** Optional summary of what's changed (e.g. "3 fields changed"). */
  summary?: string;
  saving?: boolean;
  onSave: () => void;
  onDiscard?: () => void;
  saveLabel?: string;
  discardLabel?: string;
};

export default function StickySaveBar({
  visible,
  summary,
  saving = false,
  onSave,
  onDiscard,
  saveLabel = 'Save changes',
  discardLabel = 'Discard',
}: Props) {
  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4">
      <div className="rm-sticky-save pointer-events-auto flex w-full max-w-3xl items-center gap-4 rounded-xl border border-slate-700/80 bg-slate-900/95 px-4 py-3 shadow-2xl shadow-black/60 backdrop-blur">
        <div className="flex h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-100">You have unsaved changes</p>
          {summary && <p className="truncate text-xs text-slate-400">{summary}</p>}
        </div>
        {onDiscard && (
          <button
            type="button"
            onClick={onDiscard}
            disabled={saving}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-slate-100 disabled:opacity-50"
          >
            {discardLabel}
          </button>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-blue-500/20 transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {saving ? 'Saving…' : saveLabel}
        </button>
      </div>
    </div>
  );
}