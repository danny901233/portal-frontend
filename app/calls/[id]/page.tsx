'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import { fetchCallById } from '../../lib/api';
import { getGarageId, isReceptionMateStaff } from '../../lib/auth';
import { getFeedbackReasonLabel } from '../../lib/callFeedback';
import { getCallTagLabel, getCallTagStyle } from '../../lib/callTags';
import type { CallRecord } from '../../types';
import { ToolCallEntry } from './components/ToolCallEntry';
import { LogEntry } from './components/LogEntry';
import { useLang } from '@/app/i18n/LocaleProvider';

// Define transcript entry types
type MessageEntry = {
  type?: 'message';
  speaker: string;
  text: string;
  timestamp: number;
  confidence?: number; // STT confidence (0-1)
  latency_ms?: number; // Response latency in milliseconds
};

type ToolCallEntry_Type = {
  type: 'tool_call';
  tool: string;
  parameters: Record<string, any>;
  result?: any;
  success: boolean;
  duration_ms: number;
  error?: string;
  retry_count?: number;
  timestamp: number;
};

type LogEntry_Type = {
  type: 'log';
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  logger: string;
  message: string;
  timestamp: number;
  attributes?: Record<string, any>;
};

type FunctionCallEntry = {
  type: 'function_call';
  id?: string;
  call_id?: string;
  name: string;
  arguments: string | Record<string, any>;
  created_at: number;
  extra?: Record<string, any>;
};

type FunctionCallOutputEntry = {
  type: 'function_call_output';
  id?: string;
  call_id?: string;
  name: string;
  output: string | any;
  is_error?: boolean;
  created_at: number;
};

type AgentHandoffEntry = {
  type: 'agent_handoff';
  id?: string;
  new_agent_id?: string;
  created_at: number;
};

type TranscriptEntry_Union = MessageEntry | ToolCallEntry_Type | LogEntry_Type | FunctionCallEntry | FunctionCallOutputEntry | AgentHandoffEntry;

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

const METRIC_EXCLUDE_KEYS = new Set([
  'transcriptlength',
  'sttautoduration',
  'ttsaudioduration',
  'tts',
  'ttscharacterscount',
]);

const MetricCard = ({ label, value }: { label: string; value: number | string | boolean | null | object }) => {
  const lang = useLang();
  const c = { en: { yes: 'Yes', no: 'No' }, fr: { yes: 'Oui', no: 'Non' } }[lang];
  let displayValue: string;
  if (typeof value === 'number') {
    displayValue = numberFormatter.format(value);
  } else if (typeof value === 'boolean') {
    displayValue = value ? c.yes : c.no;
  } else if (value === null) {
    displayValue = '—';
  } else if (typeof value === 'object' && value !== null) {
    displayValue = JSON.stringify(value, null, 2);
  } else {
    displayValue = String(value);
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900 whitespace-pre-wrap break-words text-sm">{displayValue}</div>
    </div>
  );
};

const TranscriptEntry = ({
  entry,
  offsetSeconds,
  allEntries,
}: {
  entry: TranscriptEntry_Union;
  offsetSeconds: number;
  allEntries?: TranscriptEntry_Union[];
}) => {
  const lang = useLang();
  const c = {
    en: {
      error: 'Error',
      result: 'Result',
      agentHandoff: 'Agent handoff',
      confidence: 'confidence',
    },
    fr: {
      error: 'Erreur',
      result: 'Résultat',
      agentHandoff: 'Transfert d’agent',
      confidence: 'confiance',
    },
  }[lang];
  // Handle function_call (new agent format) — merge with its matching function_call_output (by
  // call_id) so we show the REAL result, success and duration, not a hardcoded green tick / 0ms.
  if ('type' in entry && entry.type === 'function_call') {
    const funcEntry = entry as any;
    let parameters = {};
    try {
      parameters = typeof funcEntry.arguments === 'string' ? JSON.parse(funcEntry.arguments) : funcEntry.arguments || {};
    } catch {
      parameters = {};
    }
    const output = (allEntries || []).find(
      (e: any) => e?.type === 'function_call_output' && funcEntry.call_id && e.call_id === funcEntry.call_id,
    ) as any;
    const hasResult = !!output;
    const duration =
      hasResult && output.created_at && funcEntry.created_at
        ? Math.max(0, Math.round((output.created_at - funcEntry.created_at) * 1000))
        : 0;
    return (
      <ToolCallEntry
        tool={funcEntry.name || 'unknown'}
        parameters={parameters}
        result={hasResult ? output.output : undefined}
        success={hasResult ? !output.is_error : true}
        duration={duration}
        timestamp={funcEntry.created_at}
      />
    );
  }

  // Handle function_call_output (new agent format). If it has a matching function_call it's already
  // merged into that entry above — skip it to avoid a duplicate row. Respect is_error for styling.
  if ('type' in entry && entry.type === 'function_call_output') {
    const funcEntry = entry as any;
    const merged = (allEntries || []).some(
      (e: any) => e?.type === 'function_call' && funcEntry.call_id && e.call_id === funcEntry.call_id,
    );
    if (merged) return null;
    const isError = !!funcEntry.is_error;
    return (
      <div className={`rounded-lg border p-4 ${isError ? 'border-red-800/40 bg-red-950/30' : 'border-emerald-800/40 bg-emerald-950/30'}`}>
        <div className="flex items-center gap-2">
          <div className={`text-xs font-semibold uppercase tracking-wide ${isError ? 'text-red-700' : 'text-emerald-700'}`}>
            {funcEntry.name} {isError ? c.error : c.result}
          </div>
        </div>
        <div className="mt-2 whitespace-pre-line text-sm text-slate-600">
          {typeof funcEntry.output === 'string' ? funcEntry.output : JSON.stringify(funcEntry.output, null, 2)}
        </div>
      </div>
    );
  }

  // Handle tool calls (old format)
  if ('type' in entry && entry.type === 'tool_call') {
    return (
      <ToolCallEntry
        tool={entry.tool || 'unknown'}
        parameters={entry.parameters || {}}
        result={entry.result}
        success={entry.success ?? true}
        duration={entry.duration_ms || 0}
        error={entry.error}
        retryCount={entry.retry_count}
        timestamp={entry.timestamp}
      />
    );
  }

  // Handle log entries
  if ('type' in entry && entry.type === 'log') {
    return (
      <LogEntry
        level={entry.level || 'INFO'}
        logger={entry.logger || 'unknown'}
        message={entry.message || ''}
        timestamp={entry.timestamp ? new Date(entry.timestamp * 1000).toISOString() : new Date().toISOString()}
        attributes={entry.attributes}
      />
    );
  }

  // Handle agent_handoff entries (usually hidden, just show a simple message)
  if ('type' in entry && entry.type === 'agent_handoff') {
    return (
      <div className="rounded-lg border border-purple-800/40 bg-purple-950/30 p-3">
        <div className="text-xs text-purple-400">{c.agentHandoff}: {entry.new_agent_id || 'unknown'}</div>
      </div>
    );
  }

  // Regular conversation message - must have speaker and text properties
  if (!('speaker' in entry) || !('text' in entry)) {
    return null; // Skip entries without speaker/text
  }

  const isStaff = isReceptionMateStaff();
  const confidence = 'confidence' in entry ? entry.confidence : undefined;
  const latency = 'latency_ms' in entry ? entry.latency_ms : undefined;
  
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-slate-500">{entry.speaker}</div>
        {isStaff && (confidence !== undefined || latency !== undefined) && (
          <div className="flex items-center gap-3 text-[10px] text-slate-500">
            {confidence !== undefined && (
              <span className={confidence > 0.9 ? 'text-emerald-500' : confidence > 0.7 ? 'text-amber-500' : 'text-rose-500'}>
                {(confidence * 100).toFixed(0)}% {c.confidence}
              </span>
            )}
            {latency !== undefined && (
              <span className={latency < 500 ? 'text-emerald-500' : latency < 1500 ? 'text-amber-500' : 'text-rose-500'}>
                {latency}ms
              </span>
            )}
          </div>
        )}
      </div>
      <div className="mt-2 whitespace-pre-line text-sm text-slate-900">{entry.text}</div>
      <div className="mt-2 text-xs text-slate-500">{offsetSeconds}s</div>
    </div>
  );
};

const PHONE_REGEX = /\b(?:\+?\d[\d\s-]{6,})\b/;

const deriveCallerName = (call: CallRecord): string => {
  // First check if customerName is directly available
  if (call.customerName && call.customerName.trim()) {
    return call.customerName.trim();
  }

  // Fallback: try to extract from summary
  const summary = call.summary ?? '';
  const namedLine = summary.match(/Customer name:\s*([^\n]+)/i);
  if (namedLine) {
    const candidate = namedLine[1].trim();
    if (candidate) {
      return candidate;
    }
  }

  const sentenceMatch = summary.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:called|spoke|Phone)/i);
  if (sentenceMatch) {
    const candidate = sentenceMatch[1].trim();
    if (candidate && !/^the caller$/i.test(candidate)) {
      return candidate;
    }
  }

  return 'Unknown caller';
};

const deriveCallerNumber = (call: CallRecord): string | null => {
  // Use fromNumber if available (actual SIP caller ID) — matches the list page's "From Number" column
  if (call.fromNumber) {
    return call.fromNumber;
  }

  // Fallback to customerPhone if fromNumber not available
  if (call.customerPhone) {
    return call.customerPhone;
  }

  // Fallback to extracting from summary text
  const summary = call.summary ?? '';
  const summaryMatch = summary.match(PHONE_REGEX);
  if (summaryMatch) {
    return summaryMatch[0].trim();
  }

  // Fallback to transcript
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
  const isStaff = isReceptionMateStaff();
  const lang = useLang();
  const c = {
    en: {
      backToCalls: '← Back to calls',
      loadingDetails: 'Loading call details…',
      unableToLoad: 'Unable to load this call.',
      tryAgainLater: 'Please try again later.',
      callDetails: 'Call Details',
      recordedOn: (date: string) => `Recorded on ${date}`,
      callId: 'Call ID',
      copy: 'Copy',
      copied: 'Copied!',
      shareCallId: 'Share this call ID with ReceptionMate support if you need help investigating the conversation.',
      aiDiagnosis: 'AI call diagnosis',
      issue: '⚠ Issue',
      ok: '✓ OK',
      analysing: 'Analysing…',
      analyseInDepth: 'Analyse in depth',
      analyseThisCall: 'Analyse this call',
      suggested: 'Suggested:',
      deepDive: 'Deep-dive',
      rootCause: 'Root cause:',
      suggestedFix: 'Suggested fix:',
      noDiagnosis: 'No diagnosis yet — click to analyse this call.',
      analysisFailed: 'Analysis failed',
      callTag: 'Call Tag',
      callerName: 'Caller Name',
      callerNumber: 'Caller Number',
      conversationSummary: 'Conversation Summary',
      transcript: 'Transcript',
      scrollToExplore: 'Scroll to explore the full conversation.',
      scrollToReadMore: 'Scroll to read more',
      callFeedback: 'Call Feedback',
      rating: 'Rating:',
      positive: 'Positive',
      negative: 'Negative',
      reasons: 'Reasons',
      notes: 'Notes',
      updated: (date: string) => `Updated ${date}`,
      callRecording: 'Call Recording',
      downloadRecording: 'Download Recording',
      recordingFromTwilio: (caller: string) => `Recording available from Twilio (caller: ${caller})`,
      fetchingRecording: 'Fetching recording...',
      loadRecording: 'Load Recording',
      noRecording: 'No recording available for this call (no customer phone number stored).',
    },
    fr: {
      backToCalls: '← Retour aux appels',
      loadingDetails: 'Chargement des détails de l’appel…',
      unableToLoad: 'Impossible de charger cet appel.',
      tryAgainLater: 'Veuillez réessayer plus tard.',
      callDetails: 'Détails de l’appel',
      recordedOn: (date: string) => `Enregistré le ${date}`,
      callId: 'ID d’appel',
      copy: 'Copier',
      copied: 'Copié !',
      shareCallId: 'Communiquez cet ID d’appel au support ReceptionMate si vous avez besoin d’aide pour analyser la conversation.',
      aiDiagnosis: 'Diagnostic d’appel par IA',
      issue: '⚠ Problème',
      ok: '✓ OK',
      analysing: 'Analyse en cours…',
      analyseInDepth: 'Analyser en profondeur',
      analyseThisCall: 'Analyser cet appel',
      suggested: 'Suggestion :',
      deepDive: 'Analyse approfondie',
      rootCause: 'Cause principale :',
      suggestedFix: 'Correction suggérée :',
      noDiagnosis: 'Pas encore de diagnostic — cliquez pour analyser cet appel.',
      analysisFailed: 'Échec de l’analyse',
      callTag: 'Catégorie d’appel',
      callerName: 'Nom de l’appelant',
      callerNumber: 'Numéro de l’appelant',
      conversationSummary: 'Résumé de la conversation',
      transcript: 'Transcription',
      scrollToExplore: 'Faites défiler pour explorer toute la conversation.',
      scrollToReadMore: 'Faites défiler pour en lire plus',
      callFeedback: 'Avis sur l’appel',
      rating: 'Évaluation :',
      positive: 'Positive',
      negative: 'Négative',
      reasons: 'Raisons',
      notes: 'Remarques',
      updated: (date: string) => `Mis à jour le ${date}`,
      callRecording: 'Enregistrement de l’appel',
      downloadRecording: 'Télécharger l’enregistrement',
      recordingFromTwilio: (caller: string) => `Enregistrement disponible depuis Twilio (appelant : ${caller})`,
      fetchingRecording: 'Récupération de l’enregistrement...',
      loadRecording: 'Charger l’enregistrement',
      noRecording: 'Aucun enregistrement disponible pour cet appel (aucun numéro de téléphone client enregistré).',
    },
  }[lang];
  const [copied, setCopied] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [fetchingRecording, setFetchingRecording] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);

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

  const fetchRecording = useCallback(async () => {
    if (!callId || fetchingRecording) {
      return;
    }
    
    setFetchingRecording(true);
    setRecordingError(null);
    
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('rm_token') : null;
      const response = await fetch(`/internal-api/calls/${callId}/recording`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to fetch recording' }));
        throw new Error(error.error || 'Failed to fetch recording');
      }
      
      const data = await response.json();
      setRecordingUrl(data.recordingUrl);
    } catch (error) {
      console.error('Error fetching recording:', error);
      setRecordingError(error instanceof Error ? error.message : 'Failed to fetch recording');
    } finally {
      setFetchingRecording(false);
    }
  }, [callId, fetchingRecording]);

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

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  // Track whether the transcript box is scrolled to (near) the bottom, so the
  // "scroll to read more" fade/pill hides once there's nothing left to read.
  const [transcriptAtBottom, setTranscriptAtBottom] = useState(false);
  const handleTranscriptScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setTranscriptAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }, []);
  const runDeepAnalysis = useCallback(async () => {
    if (!callId || analyzing) {
      return;
    }
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('rm_token') : null;
      const res = await fetch(`/internal-api/calls/${callId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ model: 'gpt-4o' }),
      });
      if (!res.ok) {
        throw new Error(c.analysisFailed);
      }
      await query.refetch();
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : c.analysisFailed);
    } finally {
      setAnalyzing(false);
    }
  }, [callId, analyzing, query, c.analysisFailed]);

  if (!callId) {
    notFound();
  }

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <Link href="/calls" className="text-sm text-brand-600 hover:text-brand-700">
          {c.backToCalls}
        </Link>
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-slate-600">
          {c.loadingDetails}
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="space-y-4">
        <Link href="/calls" className="text-sm text-brand-600 hover:text-brand-700">
          {c.backToCalls}
        </Link>
        <div className="rounded-lg border border-rose-300 bg-rose-50 p-6 text-sm text-rose-800">
          {c.unableToLoad} {query.error instanceof Error ? query.error.message : c.tryAgainLater}
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
  const diagnosis = (call.metrics as Record<string, unknown> | null | undefined)?.['diagnosis'] as
    | { status?: string; headline?: string; detail?: string; suggestedAction?: string; model?: string;
        generatedAt?: string; rootCause?: string; fix?: string; severity?: string; deepModel?: string }
    | undefined;
  
  // Filter transcript based on user role.
  // Sort chronologically so tool calls land INLINE at the point they were invoked. Use a NaN-safe
  // timestamp resolver (older entries use `created_at`, not `timestamp`) and a stable index tie-break,
  // because a comparator that ever returns NaN scrambles the whole order in V8 and scatters tool calls.
  const tsOf = (e: TranscriptEntry_Union): number => {
    const raw = (e as { timestamp?: unknown; created_at?: unknown }).timestamp
      ?? (e as { created_at?: unknown }).created_at;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : 0;
  };
  const allTranscript = call.transcript
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => tsOf(a.entry) - tsOf(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
  const transcript = isStaff
    ? allTranscript // Staff sees everything
    : allTranscript.filter((entry) => {
        // Non-staff users only see messages, not tool_calls/function_calls or logs
        const entryType = 'type' in entry ? entry.type : 'message';
        // Allow: message, agent_handoff, or entries without type field
        // Block: function_call, function_call_output, tool_call, log
        return entryType === 'message' || entryType === 'agent_handoff' || !('type' in entry);
      });
  
  const firstTimestamp = transcript[0]?.timestamp ?? 0;
  const showTranscriptHint = transcript.length > 3 && !transcriptAtBottom;
  const metricEntries = Object.entries(call.metrics ?? {})
    .filter(([key, value]) => {
      const normalised = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (normalised.includes('token')) {
        return false;
      }
      if (normalised.includes('sttaudio')) {
        return false;
      }
      // Internal diagnostics fields — not shown as raw metric cards (the diagnosis card + tool
      // timeline render these properly; agent_prompt is large and for the AI deep-dive only).
      if (['agentprompt', 'diagnosis', 'toolcallhistory', 'ghtrace', 'latency', 'capture'].includes(normalised)) {
        return false;
      }
      // Filter out arrays and large objects (like tool_calls, llm_responses)
      if (Array.isArray(value)) {
        return false;
      }
      return !METRIC_EXCLUDE_KEYS.has(normalised);
    })
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      <Link href="/calls" className="inline-flex items-center text-sm text-brand-600 hover:text-brand-700">
        {c.backToCalls}
      </Link>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">{c.callDetails}</h1>
        <span
          className={`${getCallTagStyle(call.callType)} inline-flex w-fit items-center rounded-full px-3 py-1 text-xs font-semibold shadow-sm shadow-slate-900/30`}
        >
          {getCallTagLabel(call.callType, lang)}
        </span>
        <p className="text-sm text-slate-500">{c.recordedOn(new Date(call.createdAt).toLocaleString())}</p>
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
          <span>{c.callId}</span>
          <code className="rounded bg-white px-2 py-1 text-[11px] text-slate-700">{call.id}</code>
          <button
            type="button"
            onClick={copyCallId}
            className="rounded border border-slate-300 px-2 py-1 text-[11px] text-brand-600 transition-colors hover:border-slate-500 hover:text-brand-700"
          >
            {c.copy}
          </button>
          {copied ? <span className="text-[11px] text-emerald-300">{c.copied}</span> : null}
        </div>
        <p className="text-[11px] text-slate-500">
          {c.shareCallId}
        </p>
      </div>

      {isStaff ? (
        <section
          className={`rounded-xl border p-5 ${
            diagnosis?.status === 'issue'
              ? 'border-amber-300 bg-amber-50'
              : diagnosis
                ? 'border-emerald-300 bg-emerald-50'
                : 'border-slate-200 bg-white'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{c.aiDiagnosis}</span>
              {diagnosis ? (
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    diagnosis.status === 'issue' ? 'bg-amber-200 text-amber-900' : 'bg-emerald-200 text-emerald-900'
                  }`}
                >
                  {diagnosis.status === 'issue' ? c.issue : c.ok}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={runDeepAnalysis}
              disabled={analyzing}
              className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-brand-600 transition-colors hover:border-slate-500 hover:text-brand-700 disabled:opacity-50"
            >
              {analyzing ? c.analysing : diagnosis ? c.analyseInDepth : c.analyseThisCall}
            </button>
          </div>
          {diagnosis ? (
            <div className="mt-3 space-y-1">
              <p className="text-sm font-semibold text-slate-900">{diagnosis.headline}</p>
              <p className="text-sm text-slate-700">{diagnosis.detail}</p>
              {diagnosis.suggestedAction && !diagnosis.fix ? (
                <p className="text-sm text-slate-600">
                  <span className="font-medium">{c.suggested}</span> {diagnosis.suggestedAction}
                </p>
              ) : null}
              {diagnosis.rootCause || diagnosis.fix ? (
                <div className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-white/70 p-3">
                  <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    {c.deepDive}
                    {diagnosis.severity ? (
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                        diagnosis.severity === 'high' ? 'bg-rose-200 text-rose-900'
                          : diagnosis.severity === 'low' ? 'bg-slate-200 text-slate-700'
                          : 'bg-amber-200 text-amber-900'}`}>{diagnosis.severity}</span>
                    ) : null}
                  </p>
                  {diagnosis.rootCause ? (
                    <p className="text-sm text-slate-700"><span className="font-medium">{c.rootCause}</span> {diagnosis.rootCause}</p>
                  ) : null}
                  {diagnosis.fix ? (
                    <p className="text-sm text-slate-700"><span className="font-medium">{c.suggestedFix}</span> {diagnosis.fix}</p>
                  ) : null}
                </div>
              ) : null}
              <p className="text-[11px] text-slate-400">
                {diagnosis.model}{diagnosis.deepModel ? ` + ${diagnosis.deepModel}` : ''}
                {diagnosis.generatedAt ? ` · ${new Date(diagnosis.generatedAt).toLocaleString()}` : ''}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-500">{c.noDiagnosis}</p>
          )}
          {analyzeError ? <p className="mt-2 text-xs text-rose-600">{analyzeError}</p> : null}
        </section>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <MetricCard label={c.callTag} value={getCallTagLabel(call.callType, lang)} />
        <MetricCard label={c.callerName} value={callerName} />
        <MetricCard label={c.callerNumber} value={callerNumber} />
      </section>

      {isStaff && metricEntries.length > 0 ? (
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {metricEntries.map(([key, value]) => (
            <MetricCard key={key} label={key.replace(/_/g, ' ')} value={value} />
          ))}
        </section>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <h2 className="text-lg font-semibold text-slate-900">{c.conversationSummary}</h2>
            <p className="mt-2 text-sm text-slate-600">{call.summary}</p>
          </div>

          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">{c.transcript}</h2>
            <p className="text-xs uppercase tracking-wide text-slate-500">{c.scrollToExplore}</p>
            <div className="relative">
              <div
                className="max-h-[48rem] space-y-3 overflow-y-auto pr-2 pb-16"
                onScroll={handleTranscriptScroll}
              >
                {transcript.map((entry: CallRecord['transcript'][number], index) => (
                  <TranscriptEntry
                    key={`${entry.speaker}-${entry.timestamp}-${index}`}
                    entry={entry}
                    allEntries={transcript}
                    offsetSeconds={Math.max(0, Math.round(entry.timestamp - firstTimestamp))}
                  />
                ))}
              </div>
              {showTranscriptHint ? (
                <>
                  <div
                    className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-slate-900 via-slate-900/60 to-transparent z-10"
                    aria-hidden
                  />
                  <div
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-slate-900 via-slate-900/60 to-transparent z-10"
                    aria-hidden
                  />
                  <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center z-20">
                    <span className="rounded-full bg-white px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-slate-600 shadow-lg shadow-slate-900/60">
                      {c.scrollToReadMore}
                    </span>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {call.feedback ? (
            <div className="rounded-xl border border-slate-200 bg-white p-6">
              <h2 className="text-lg font-semibold text-slate-900">{c.callFeedback}</h2>
              <div className="mt-3 text-sm">
                <span className="text-slate-500">{c.rating}</span>{' '}
                <span className={call.feedback.rating === 'up' ? 'font-semibold text-emerald-300' : 'font-semibold text-rose-300'}>
                  {call.feedback.rating === 'up' ? c.positive : c.negative}
                </span>
              </div>
              {call.feedback.reasons.length > 0 ? (
                <div className="mt-4">
                  <div className="text-xs uppercase tracking-wide text-slate-500">{c.reasons}</div>
                  <ul className="mt-2 space-y-1">
                    {call.feedback.reasons.filter(Boolean).map((reason) => (
                      <li
                        key={reason}
                        className="inline-flex items-center rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                      >
                        {getFeedbackReasonLabel(reason, lang)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {call.feedback.notes ? (
                <div className="mt-4">
                  <div className="text-xs uppercase tracking-wide text-slate-500">{c.notes}</div>
                  <p className="mt-2 whitespace-pre-line text-sm text-slate-700">
                    {call.feedback.notes}
                  </p>
                </div>
              ) : null}
              <div className="mt-4 text-xs text-slate-500">
                {c.updated(new Date(call.feedback.updatedAt).toLocaleString())}
              </div>
            </div>
          ) : null}
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">{c.callRecording}</h2>
            
            {call.recordingUrl || recordingUrl ? (
              <div className="space-y-3">
                <audio
                  src={
                    (call.recordingUrl || recordingUrl || '').startsWith('/internal-api/')
                      ? call.recordingUrl || recordingUrl || ''
                      : `/internal-api/calls/${call.id}/recording/audio`
                  }
                  controls
                  className="w-full"
                />
                <a
                  href={
                    (call.recordingUrl || recordingUrl || '').startsWith('/internal-api/')
                      ? call.recordingUrl || recordingUrl || ''
                      : `/internal-api/calls/${call.id}/recording/audio`
                  }
                  download={`call-${call.id}-recording.mp3`}
                  className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1 text-xs text-brand-600 hover:border-slate-500 hover:text-brand-700"
                >
                  {c.downloadRecording}
                </a>
              </div>
            ) : call.customerPhone ? (
              <div className="space-y-3">
                <p className="text-sm text-slate-500">
                  {c.recordingFromTwilio(formatPhoneNumber(call.customerPhone))}
                </p>
                <button
                  onClick={fetchRecording}
                  disabled={fetchingRecording}
                  className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {fetchingRecording ? c.fetchingRecording : c.loadRecording}
                </button>
                {recordingError && (
                  <p className="text-sm text-rose-700">{recordingError}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                {c.noRecording}
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
