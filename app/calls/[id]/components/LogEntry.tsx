'use client';

import { useState } from 'react';
import { ChevronDown, FileText, Info, AlertTriangle, XCircle } from 'lucide-react';
import { useLang } from '@/app/i18n/LocaleProvider';

interface LogEntryProps {
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  logger: string;
  message: string;
  timestamp: string;
  attributes?: Record<string, any>;
}

const LEVEL_CONFIG = {
  INFO: {
    icon: Info,
    color: 'text-blue-400',
    bg: 'bg-blue-950/30',
    border: 'border-blue-500',
  },
  WARN: {
    icon: AlertTriangle,
    color: 'text-amber-700',
    bg: 'bg-amber-950/30',
    border: 'border-amber-500',
  },
  ERROR: {
    icon: XCircle,
    color: 'text-red-400',
    bg: 'bg-red-950/30',
    border: 'border-red-500',
  },
  DEBUG: {
    icon: FileText,
    color: 'text-slate-500',
    bg: 'bg-slate-50',
    border: 'border-slate-500',
  },
};

export function LogEntry({ level, logger, message, timestamp, attributes }: LogEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const lang = useLang();
  const c = { en: { attributes: 'Attributes' }, fr: { attributes: 'Attributs' } }[lang];
  const config = LEVEL_CONFIG[level] || LEVEL_CONFIG.INFO;
  const Icon = config.icon;

  // Extract relevant attributes (exclude generic ones)
  const relevantAttributes = attributes
    ? Object.entries(attributes).filter(
        ([key]) =>
          !key.startsWith('code.') &&
          !['room_id', 'job_id', 'logger.name', 'lk.id'].includes(key)
      )
    : [];

  const hasAttributes = relevantAttributes.length > 0;

  return (
    <div className={`my-2 border-l-4 ${config.border} ${config.bg} rounded-lg overflow-hidden`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full px-4 py-3 flex items-start gap-3 hover:opacity-80 transition-opacity ${
          hasAttributes ? 'cursor-pointer' : 'cursor-default'
        }`}
        disabled={!hasAttributes}
      >
        <Icon className={`w-4 h-4 ${config.color} flex-shrink-0 mt-0.5`} />
        <div className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs font-bold ${config.color} uppercase`}>{level}</span>
            <span className="text-xs text-slate-500 font-mono">{logger}</span>
          </div>
          <div className="text-sm text-slate-700 break-words">{message}</div>
          <div className="text-xs text-slate-500 mt-1">
            {new Date(timestamp).toLocaleString()}
          </div>
        </div>
        {hasAttributes && (
          <ChevronDown
            className={`w-4 h-4 text-slate-500 transition-transform flex-shrink-0 mt-1 ${
              expanded ? 'rotate-180' : ''
            }`}
          />
        )}
      </button>

      {expanded && hasAttributes && (
        <div className="px-4 py-3 space-y-3 text-sm bg-slate-50 border-t border-slate-300">
          <div>
            <div className="text-slate-600 font-semibold mb-2 text-xs uppercase tracking-wide">
              {c.attributes}
            </div>
            <div className="space-y-2">
              {relevantAttributes.map(([key, value]) => (
                <div key={key} className="flex gap-2">
                  <span className="text-slate-500 font-mono text-xs min-w-[120px]">
                    {key}:
                  </span>
                  <span className="text-slate-700 text-xs font-mono break-all">
                    {typeof value === 'object'
                      ? JSON.stringify(value, null, 2)
                      : String(value)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
