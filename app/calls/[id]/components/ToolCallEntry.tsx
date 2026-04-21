'use client';

import { useState } from 'react';
import { ChevronDown, Wrench, Check, X, AlertCircle } from 'lucide-react';

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

  return (
    <div className="my-2 border-l-4 border-cyan-500 bg-cyan-950/30 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-cyan-900/20 transition-colors"
      >
        <Wrench className="w-4 h-4 text-cyan-400 flex-shrink-0" />
        <span className="text-cyan-400 font-mono text-sm font-medium">
          Tool call: {tool}
        </span>
        {retryCount > 0 && (
          <span className="text-xs text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded">
            Retry #{retryCount}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {success ? (
            <Check className="w-4 h-4 text-green-400" />
          ) : (
            <X className="w-4 h-4 text-red-400" />
          )}
          <span className="text-xs text-slate-400 font-mono">
            {duration.toFixed(0)}ms
          </span>
          <ChevronDown
            className={`w-4 h-4 text-slate-400 transition-transform ${
              expanded ? 'rotate-180' : ''
            }`}
          />
        </div>
      </button>

      {expanded && (
        <div className="px-4 py-3 space-y-3 text-sm bg-slate-950/40 border-t border-cyan-500/20">
          <div>
            <div className="text-cyan-300 font-semibold mb-2 text-xs uppercase tracking-wide">
              Parameters
            </div>
            <pre className="bg-black/60 p-3 rounded-md overflow-x-auto text-xs font-mono text-slate-300 border border-slate-800">
              {JSON.stringify(parameters, null, 2)}
            </pre>
          </div>

          {result !== undefined && result !== null && (
            <div>
              <div className="text-cyan-300 font-semibold mb-2 text-xs uppercase tracking-wide">
                Result
              </div>
              <pre className="bg-black/60 p-3 rounded-md overflow-x-auto text-xs font-mono text-slate-300 border border-slate-800">
                {typeof result === 'string'
                  ? result
                  : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}

          {error && (
            <div>
              <div className="text-red-300 font-semibold mb-2 text-xs uppercase tracking-wide flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                Error
              </div>
              <div className="bg-red-950/40 border border-red-500/30 p-3 rounded-md text-red-200 text-xs">
                {error}
              </div>
            </div>
          )}

          {timestamp && (
            <div className="text-xs text-slate-500 pt-2 border-t border-slate-800">
              Executed at {new Date(timestamp * 1000).toLocaleTimeString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
