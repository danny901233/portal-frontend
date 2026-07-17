'use client';

import { useState } from 'react';
import { ChevronDown, Wrench, Check, X, AlertCircle } from 'lucide-react';
import { useLang } from '@/app/i18n/LocaleProvider';

interface ToolCallEntryProps {
  tool: string;
  parameters: Record<string, any>;
  result: any;
  success: boolean;
  duration: number;
  error?: string;
  retryCount?: number;
  timestamp?: number;
}

export function ToolCallEntry({
  tool,
  parameters,
  result,
  success,
  duration,
  error,
  retryCount = 0,
  timestamp,
}: ToolCallEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const lang = useLang();
  const c = {
    en: {
      toolCall: 'Tool call',
      retry: 'Retry',
      parameters: 'Parameters',
      result: 'Result',
      error: 'Error',
      executedAt: (time: string) => `Executed at ${time}`,
    },
    fr: {
      toolCall: 'Appel outil',
      retry: 'Nouvel essai',
      parameters: 'Paramètres',
      result: 'Résultat',
      error: 'Erreur',
      executedAt: (time: string) => `Exécuté à ${time}`,
    },
  }[lang];

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center gap-3 bg-brand-600 text-white hover:bg-brand-700 transition-colors"
      >
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/15 text-white">
          <Wrench className="w-4 h-4" />
        </span>
        <span className="font-mono text-sm font-semibold">
          {c.toolCall}: {tool}
        </span>
        {retryCount > 0 && (
          <span className="inline-flex h-5 px-2 items-center justify-center rounded-full bg-amber-400/20 text-amber-100 text-[11px] font-semibold">
            {c.retry} #{retryCount}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {success ? (
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-400/20 text-emerald-100">
              <Check className="w-3 h-3" />
            </span>
          ) : (
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-400/20 text-rose-100">
              <X className="w-3 h-3" />
            </span>
          )}
          <span className="text-xs text-brand-100 font-mono">
            {duration.toFixed(0)}ms
          </span>
          <ChevronDown
            className={`w-4 h-4 text-brand-100 transition-transform ${
              expanded ? 'rotate-180' : ''
            }`}
          />
        </div>
      </button>

      {expanded && (
        <div className="px-4 py-3 space-y-3 bg-white">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-700 mb-1.5">
              {c.parameters}
            </div>
            <pre className="bg-slate-900 text-slate-100 p-3.5 rounded-lg overflow-auto max-h-[32rem] whitespace-pre-wrap break-words text-xs font-mono border border-slate-800">
              {JSON.stringify(parameters, null, 2)}
            </pre>
          </div>

          {result !== undefined && result !== null && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-700 mb-1.5">
                {c.result}
              </div>
              <pre className="bg-slate-900 text-slate-100 p-3.5 rounded-lg overflow-auto max-h-[32rem] whitespace-pre-wrap break-words text-xs font-mono border border-slate-800">
                {typeof result === 'string'
                  ? result
                  : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}

          {error && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-rose-700 mb-1.5 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                {c.error}
              </div>
              <div className="bg-rose-50 border border-rose-200 p-3 rounded-md text-rose-800 text-xs">
                {error}
              </div>
            </div>
          )}

          {timestamp && (
            <div className="text-xs text-slate-500 pt-2 border-t border-slate-200">
              {c.executedAt(new Date(timestamp * 1000).toLocaleTimeString())}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
