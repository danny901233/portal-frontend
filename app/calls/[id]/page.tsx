'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import { fetchCallById } from '../../lib/api';
import { getGarageId } from '../../lib/auth';
import { getFeedbackReasonLabel } from '../../lib/callFeedback';
import { getCallTagLabel, getCallTagStyle } from '../../lib/callTags';
import type { CallRecord } from '../../types';

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

const formatDuration = (seconds?: number | null) => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return '—';
  }
  const total = Math.max(0, Math.trunc(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes === 0) {
    return `${secs}s`;
  }
  if (secs === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${secs}s`;
};

const METRIC_EXCLUDE_KEYS = new Set([
  'transcriptlength',
  'sttautoduration',
  'ttsaudioduration',
  'tts',
  'ttscharacterscount',
]);

const MetricCard = ({ label, value }: { label: string; value: number | string | boolean | null }) => {
  let displayValue: string;
  if (typeof value === 'number') {
    displayValue = numberFormatter.format(value);
  } else if (typeof value === 'boolean') {
    displayValue = value ? 'Yes' : 'No';
  } else if (value === null) {
    displayValue = '—';
  } else {
    displayValue = value;
  }
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-100">{displayValue}</div>
    </div>
  );
};

const TranscriptEntry = ({
  entry,
  offsetSeconds,
}: {
  entry: CallRecord['transcript'][number];
  offsetSeconds: number;
}) => (
  <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4">
    <div className="text-xs uppercase tracking-wide text-slate-400">{entry.speaker}</div>
    <div className="mt-2 whitespace-pre-line text-sm text-slate-100">{entry.text}</div>
    <div className="mt-2 text-xs text-slate-500">{offsetSeconds}s</div>
  </div>
);

const PHONE_REGEX = /\b(?:\+?\d[\d\s-]{6,})\b/;

const deriveCallerName = (call: CallRecord): string => {
  const summary = call.summary ?? '';
  const namedLine = summary.match(/Customer name:\s*([^\n]+)/i);
  if (namedLine) {
    const candidate = namedLine[1].trim();
    if (candidate) {
      return candidate;
    }
  }

  const sentenceMatch = summary.match(/^([^.,]+?)\s+(?:called|spoke)/i);
  if (sentenceMatch) {
    const candidate = sentenceMatch[1].trim();
    if (candidate && !/^the caller$/i.test(candidate)) {
      return candidate;
    }
  }

  return 'Unknown caller';
};

const deriveCallerNumber = (call: CallRecord): string | null => {
  const summary = call.summary ?? '';
  const summaryMatch = summary.match(PHONE_REGEX);
  if (summaryMatch) {
    return summaryMatch[0].trim();
  }

  for (const entry of call.transcript) {
    if (entry.speaker && entry.speaker.toLowerCase() !== 'customer') {
      continue;
    }
    const transcriptMatch = entry.text?.match(PHONE_REGEX);
    if (transcriptMatch) {
      return transcriptMatch[0].trim();
    }
  }

  return null;
};

const formatPhoneNumber = (value?: string | null): string => {
  if (!value) {
    return '—';
  }
  const cleaned = value.replace(/[\s-]+/g, ' ').trim();
  if (!cleaned) {
    return '—';
  }

  const compact = cleaned.replace(/\s+/g, '');
  if (/^\+?\d{6,}$/.test(compact)) {
    const hasPlus = compact.startsWith('+');
    const digitsOnly = hasPlus ? compact.slice(1) : compact;
    const grouped = digitsOnly.replace(/(\d{3,4})(?=\d)/g, '$1 ').trim();
    return hasPlus ? `+${grouped}` : grouped;
  }

  return cleaned;
};

export default function CallDetailPage() {
  const params = useParams();
  const rawId = params?.id;
  const callId = Array.isArray(rawId) ? rawId[0] : rawId;
  const garageId = getGarageId();
  const [copied, setCopied] = useState(false);
  const copyCallId = useCallback(() => {
    if (!callId) {
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(callId)
        .then(() => setCopied(true))
        .catch(() => setCopied(true));
      return;
    }
    setCopied(true);
  }, [callId]);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const query = useQuery<CallRecord>({
    queryKey: ['call-detail', garageId, callId],
    queryFn: async () => {
      if (!callId) {
        throw new Error('Missing call id');
      }
      const response = await fetchCallById(callId, garageId ?? undefined);
      return response.call;
    },
    enabled: Boolean(garageId && callId),
  });

  if (!callId) {
    notFound();
  }

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <Link href="/calls" className="text-sm text-sky-400 hover:text-sky-300">
          ← Back to calls
        </Link>
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-slate-300">
          Loading call details…
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="space-y-4">
        <Link href="/calls" className="text-sm text-sky-400 hover:text-sky-300">
          ← Back to calls
        </Link>
        <div className="rounded-lg border border-rose-500/50 bg-rose-500/10 p-6 text-sm text-rose-200">
          Unable to load this call. {query.error instanceof Error ? query.error.message : 'Please try again later.'}
        </div>
      </div>
    );
  }

  const call = query.data;
  if (!call) {
    notFound();
  }

  const callerName = deriveCallerName(call);
  const callerNumber = formatPhoneNumber(deriveCallerNumber(call));
  const transcript = [...call.transcript].sort((a, b) => a.timestamp - b.timestamp);
  const firstTimestamp = transcript[0]?.timestamp ?? 0;
  const showTranscriptHint = transcript.length > 3;
  const metricEntries = Object.entries(call.metrics ?? {})
    .filter(([key]) => {
      const normalised = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (normalised.includes('token')) {
        return false;
      }
      if (normalised.includes('sttaudio')) {
        return false;
      }
      return !METRIC_EXCLUDE_KEYS.has(normalised);
    })
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      <Link href="/calls" className="inline-flex items-center text-sm text-sky-400 hover:text-sky-300">
        ← Back to calls
      </Link>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-100">Call Details</h1>
        <span
          className={`${getCallTagStyle(call.callType)} inline-flex w-fit items-center rounded-full px-3 py-1 text-xs font-semibold shadow-sm shadow-slate-900/30`}
        >
          {getCallTagLabel(call.callType)}
        </span>
        <p className="text-sm text-slate-400">Recorded on {new Date(call.createdAt).toLocaleString()}</p>
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
          <span>Call ID</span>
          <code className="rounded bg-slate-900/80 px-2 py-1 text-[11px] text-slate-200">{call.id}</code>
          <button
            type="button"
            onClick={copyCallId}
            className="rounded border border-slate-700 px-2 py-1 text-[11px] text-sky-400 transition-colors hover:border-slate-500 hover:text-sky-300"
          >
            Copy
          </button>
          {copied ? <span className="text-[11px] text-emerald-300">Copied!</span> : null}
        </div>
        <p className="text-[11px] text-slate-500">
          Share this call ID with ReceptionMate support if you need help investigating the conversation.
        </p>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Call Tag" value={getCallTagLabel(call.callType)} />
        <MetricCard label="Duration" value={formatDuration(call.durationSeconds)} />
        <MetricCard label="Caller Name" value={callerName} />
        <MetricCard label="Caller Number" value={callerNumber} />
      </section>

      {metricEntries.length > 0 ? (
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {metricEntries.map(([key, value]) => (
            <MetricCard key={key} label={key.replace(/_/g, ' ')} value={value} />
          ))}
        </section>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
            <h2 className="text-lg font-semibold text-slate-100">Conversation Summary</h2>
            <p className="mt-2 text-sm text-slate-300">{call.summary}</p>
          </div>

          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-100">Transcript</h2>
            <p className="text-xs uppercase tracking-wide text-slate-500">Scroll to explore the full conversation.</p>
            <div className="relative">
              <div className="max-h-[28rem] space-y-3 overflow-y-auto pr-2">
                {transcript.map((entry: CallRecord['transcript'][number], index) => (
                  <TranscriptEntry
                    key={`${entry.speaker}-${entry.timestamp}-${index}`}
                    entry={entry}
                    offsetSeconds={Math.max(0, Math.round((entry.timestamp - firstTimestamp) / 1000))}
                  />
                ))}
              </div>
              {showTranscriptHint ? (
                <>
                  <div
                    className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-slate-900 via-slate-900/80 to-transparent z-10"
                    aria-hidden
                  />
                  <div
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-slate-900 via-slate-900/80 to-transparent z-10"
                    aria-hidden
                  />
                  <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center z-20">
                    <span className="rounded-full bg-slate-900/90 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-slate-300 shadow-lg shadow-slate-900/60">
                      Scroll to read more
                    </span>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {call.feedback ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
              <h2 className="text-lg font-semibold text-slate-100">Call Feedback</h2>
              <div className="mt-3 text-sm">
                <span className="text-slate-400">Rating:</span>{' '}
                <span className={call.feedback.rating === 'up' ? 'font-semibold text-emerald-300' : 'font-semibold text-rose-300'}>
                  {call.feedback.rating === 'up' ? 'Positive' : 'Negative'}
                </span>
              </div>
              {call.feedback.reasons.length > 0 ? (
                <div className="mt-4">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Reasons</div>
                  <ul className="mt-2 space-y-1">
                    {call.feedback.reasons.filter(Boolean).map((reason) => (
                      <li
                        key={reason}
                        className="inline-flex items-center rounded-md border border-slate-800 bg-slate-900/80 px-2 py-1 text-xs text-slate-200"
                      >
                        {getFeedbackReasonLabel(reason)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {call.feedback.notes ? (
                <div className="mt-4">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Notes</div>
                  <p className="mt-2 whitespace-pre-line text-sm text-slate-200">
                    {call.feedback.notes}
                  </p>
                </div>
              ) : null}
              <div className="mt-4 text-xs text-slate-500">
                Updated {new Date(call.feedback.updatedAt).toLocaleString()}
              </div>
            </div>
          ) : null}
          {call.recordingUrl ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
              <h2 className="text-lg font-semibold text-slate-100">Recording</h2>
              {/\.(mp3|wav|m4a|aac)$/i.test(call.recordingUrl) ? (
                <audio
                  src={call.recordingUrl}
                  controls
                  className="mt-3 w-full"
                />
              ) : (
                <video
                  src={call.recordingUrl}
                  controls
                  className="mt-3 w-full rounded-lg border border-slate-800 object-cover"
                />
              )}
              <a
                href={call.recordingUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center rounded-md border border-slate-700 px-3 py-1 text-xs text-sky-400 hover:border-slate-500 hover:text-sky-300"
              >
                Open in new tab
              </a>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6 text-sm text-slate-400">
              No recording available for this call.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
