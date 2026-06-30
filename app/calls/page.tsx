'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { fetchCalls, submitCallFeedback, downloadConfirmedBookingsCsv } from '../lib/api';
import { getGarageId } from '../lib/auth';
import {
  TRACKED_TAGS,
  getCallTagLabel,
  getCallTagStyle,
} from '../lib/callTags';
import { FEEDBACK_OPTIONS } from '../lib/callFeedback';
import { cn } from '../lib/utils';
import type { CallRecord, CallsResponse } from '../types';

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

const summaryPreview = (summary?: string | null, maxWords = 20) => {
  if (!summary) {
    return '';
  }
  const words = summary.trim().split(/\s+/);
  if (words.length <= maxWords) {
    return summary.trim();
  }
  return `${words.slice(0, maxWords).join(' ')}…`;
};

const toIsoDate = (value: string, endOfDay = false): string | undefined => {
  if (!value) {
    return undefined;
  }
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) {
    return undefined;
  }
  const date = new Date(Date.UTC(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0));
  return date.toISOString();
};

const formatCallTag = (raw?: string | null) => getCallTagLabel(raw);

const renderCallTag = (raw?: string | null) => {
  const label = getCallTagLabel(raw);
  const style = getCallTagStyle(raw);
  return (
    <span
      className={`${style} inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold shadow-sm shadow-slate-900/30`}
    >
      {label}
    </span>
  );
};

type FeedbackMutationVariables = {
  callId: string;
  rating: 'up' | 'down';
  reasons: string[];
  notes?: string;
  previousRating: 'up' | 'down' | null;
};

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

const PHONE_REGEX = /\b(?:\+?\d[\d\s-]{6,})\b/;

const deriveCallerNumber = (call: CallRecord): string | null => {
  // Use fromNumber if available (actual SIP caller ID)
  if (call.fromNumber) {
    return call.fromNumber;
  }
  
  // Fallback to customerPhone if fromNumber not available
  if (call.customerPhone) {
    return call.customerPhone;
  }
  
  // Fallback to extracting from summary
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

type BooleanToken =
  | { type: 'term'; value: string }
  | { type: 'operator'; value: 'and' | 'or' | 'not' }
  | { type: 'lparen' }
  | { type: 'rparen' };

type BooleanNode =
  | { kind: 'term'; value: string }
  | { kind: 'not'; child: BooleanNode }
  | { kind: 'and' | 'or'; left: BooleanNode; right: BooleanNode };

type BooleanParseResult =
  | { success: true; node: BooleanNode }
  | { success: false };

const tokenizeBooleanQuery = (input: string): BooleanToken[] => {
  const tokens: BooleanToken[] = [];
  let index = 0;

  const pushTerm = (raw: string) => {
    const value = raw.trim().toLowerCase();
    if (!value) {
      throw new Error('Empty term');
    }
    if (value === 'and' || value === 'or' || value === 'not') {
      tokens.push({ type: 'operator', value });
      return;
    }
    tokens.push({ type: 'term', value });
  };

  while (index < input.length) {
    const char = input[index];

    if (char.trim() === '') {
      index += 1;
      continue;
    }

    if (char === '"') {
      let end = index + 1;
      let phrase = '';
      while (end < input.length && input[end] !== '"') {
        phrase += input[end];
        end += 1;
      }
      if (end >= input.length) {
        throw new Error('Unterminated quote');
      }
      pushTerm(phrase);
      index = end + 1;
      continue;
    }

    if (char === '(') {
      tokens.push({ type: 'lparen' });
      index += 1;
      continue;
    }

    if (char === ')') {
      tokens.push({ type: 'rparen' });
      index += 1;
      continue;
    }

    let end = index;
    while (end < input.length) {
      const candidate = input[end];
      if (candidate.trim() === '' || candidate === '(' || candidate === ')' || candidate === '"') {
        break;
      }
      end += 1;
    }

    pushTerm(input.slice(index, end));
    index = end;
  }

  return tokens;
};

const parseBooleanTokens = (tokens: BooleanToken[]): BooleanNode => {
  let index = 0;

  const peek = () => tokens[index];
  const consume = () => tokens[index++];

  const parseExpression = (): BooleanNode => parseOr();

  const parseOr = (): BooleanNode => {
    let node = parseAnd();
    while (true) {
      const token = peek();
      if (token && token.type === 'operator' && token.value === 'or') {
        consume();
        const right = parseAnd();
        node = { kind: 'or', left: node, right };
        continue;
      }
      break;
    }
    return node;
  };

  const parseAnd = (): BooleanNode => {
    let node = parseUnary();
    while (true) {
      const token = peek();
      if (token && token.type === 'operator' && token.value === 'and') {
        consume();
        const right = parseUnary();
        node = { kind: 'and', left: node, right };
        continue;
      }
      if (
        token &&
        (token.type === 'term' || token.type === 'lparen' || (token.type === 'operator' && token.value === 'not'))
      ) {
        const right = parseUnary();
        node = { kind: 'and', left: node, right };
        continue;
      }
      break;
    }
    return node;
  };

  const parseUnary = (): BooleanNode => {
    let notCount = 0;
    while (true) {
      const token = peek();
      if (token && token.type === 'operator' && token.value === 'not') {
        consume();
        notCount += 1;
      } else {
        break;
      }
    }

    const primary = parsePrimary();
    let node = primary;
    while (notCount > 0) {
      node = { kind: 'not', child: node };
      notCount -= 1;
    }
    return node;
  };

  const parsePrimary = (): BooleanNode => {
    const token = peek();
    if (!token) {
      throw new Error('Unexpected end of expression');
    }

    if (token.type === 'term') {
      consume();
      if (!token.value) {
        throw new Error('Empty term');
      }
      return { kind: 'term', value: token.value };
    }

    if (token.type === 'lparen') {
      consume();
      const node = parseExpression();
      const next = peek();
      if (!next || next.type !== 'rparen') {
        throw new Error('Missing closing parenthesis');
      }
      consume();
      return node;
    }

    throw new Error('Unexpected token');
  };

  const node = parseExpression();
  if (index < tokens.length) {
    throw new Error('Unexpected token at end of expression');
  }
  return node;
};

const parseBooleanQuery = (input: string): BooleanParseResult => {
  const trimmed = input.trim();
  if (!trimmed) {
    return { success: false };
  }

  try {
    const tokens = tokenizeBooleanQuery(trimmed);
    if (!tokens.length) {
      return { success: false };
    }
    const node = parseBooleanTokens(tokens);
    return { success: true, node };
  } catch (error) {
    return { success: false };
  }
};

const evaluateBooleanNode = (node: BooleanNode, text: string): boolean => {
  switch (node.kind) {
    case 'term':
      return text.includes(node.value);
    case 'not':
      return !evaluateBooleanNode(node.child, text);
    case 'and':
      return evaluateBooleanNode(node.left, text) && evaluateBooleanNode(node.right, text);
    case 'or':
      return evaluateBooleanNode(node.left, text) || evaluateBooleanNode(node.right, text);
    default:
      return false;
  }
};

const buildCallSearchText = (call: CallRecord): string => {
  const transcriptText = call.transcript
    .map((entry) => `${entry.speaker ?? ''} ${entry.text ?? ''}`)
    .join(' ');
  const callerName = deriveCallerName(call);
  const callerNumber = deriveCallerNumber(call);
  const summarySnippet = summaryPreview(call.summary);

  const candidateFields: Array<string | null | undefined> = [
    call.summary,
    summarySnippet,
    call.roomName,
    call.callType,
    getCallTagLabel(call.callType),
    call.recordingUrl,
    call.id,
    transcriptText,
    callerName,
    callerNumber,
    call.feedback?.rating,
    call.feedback?.notes,
    call.feedback?.reasons?.join(' '),
  ];

  return candidateFields
    .filter((field): field is string => typeof field === 'string' && field.trim().length > 0)
    .map((field) => field.toLowerCase())
    .join(' ');
};

export default function CallsPage() {
  const garageId = getGarageId();
  const router = useRouter();
  const [callTagFilter, setCallTagFilter] = useState('all');
  const [startDateInput, setStartDateInput] = useState('');
  const [endDateInput, setEndDateInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [ratings, setRatings] = useState<Record<string, 'up' | 'down' | null>>({});
  const [feedbackModal, setFeedbackModal] = useState<{
    callId: string | null;
    rating: 'up' | 'down' | null;
    previous: 'up' | 'down' | null;
  }>({ callId: null, rating: null, previous: null });
  const [feedbackReasons, setFeedbackReasons] = useState<string[]>([]);
  const [feedbackNotes, setFeedbackNotes] = useState('');
  const [summaryModalCallId, setSummaryModalCallId] = useState<string | null>(null);
  const [loadingRecordings, setLoadingRecordings] = useState<Set<string>>(new Set());
  const [recordingErrors, setRecordingErrors] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(100);

  const startDateIso = useMemo(() => toIsoDate(startDateInput), [startDateInput]);
  const endDateIso = useMemo(() => toIsoDate(endDateInput, true), [endDateInput]);
  const callsQueryKey = useMemo(
    () => ['calls', garageId, callTagFilter, startDateIso, endDateIso, currentPage, pageSize] as const,
    [garageId, callTagFilter, startDateIso, endDateIso, currentPage, pageSize],
  );
  const isModalOpen = feedbackModal.callId !== null;
  const isSummaryModalOpen = summaryModalCallId !== null;
  const queryClient = useQueryClient();

  const query = useQuery<CallsResponse>({
    queryKey: callsQueryKey,
    queryFn: () =>
      fetchCalls(garageId ?? undefined, {
        callType: callTagFilter,
        startDate: startDateIso,
        endDate: endDateIso,
        page: currentPage,
        pageSize,
      }),
    enabled: Boolean(garageId),
  });

  const calls = useMemo<CallRecord[]>(() => query.data?.calls ?? [], [query.data]);
  const pagination = query.data?.pagination;

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [callTagFilter, startDateIso, endDateIso]);

  useEffect(() => {
    startTransition(() => {
      setRatings((prev) => {
        const next: Record<string, 'up' | 'down' | null> = {};
        for (const call of calls) {
          const rating = call.feedback?.rating;
          if (rating === 'up' || rating === 'down') {
            next[call.id] = rating;
          }
        }

        if (feedbackModal.callId && prev[feedbackModal.callId] !== undefined) {
          next[feedbackModal.callId] = prev[feedbackModal.callId];
        }

        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(next);

        if (
          prevKeys.length === nextKeys.length &&
          nextKeys.every((key) => prev[key] === next[key as keyof typeof prev])
        ) {
          return prev;
        }

        return next;
      });
    });
  }, [calls, feedbackModal.callId, startTransition]);

  useEffect(() => {
    if (!summaryModalCallId) {
      return;
    }
    if (calls.some((call) => call.id === summaryModalCallId)) {
      return;
    }
    startTransition(() => {
      setSummaryModalCallId(null);
    });
  }, [calls, summaryModalCallId, startTransition]);
  const trimmedSearch = useMemo(() => searchTerm.trim(), [searchTerm]);
  const normalizedSearch = useMemo(() => trimmedSearch.toLowerCase(), [trimmedSearch]);
  const booleanQuery = useMemo<BooleanParseResult>(() => parseBooleanQuery(searchTerm), [searchTerm]);
  const filtersActive =
    callTagFilter !== 'all' ||
    Boolean(startDateInput) ||
    Boolean(endDateInput) ||
    Boolean(trimmedSearch);
  const filteredCalls = useMemo(() => {
    if (!trimmedSearch) {
      return calls;
    }

    return calls.filter((call) => {
      const searchableText = buildCallSearchText(call);

      if (booleanQuery.success) {
        return evaluateBooleanNode(booleanQuery.node, searchableText);
      }

      return searchableText.includes(normalizedSearch);
    });
  }, [calls, trimmedSearch, normalizedSearch, booleanQuery]);

  const displayedCalls = filteredCalls;

  // Lightweight summary stats for the KPI strip
  const summaryStats = useMemo(() => {
    const total = displayedCalls.length;
    const confirmed = displayedCalls.filter((c) => Boolean(c.confirmedBooking)).length;
    const totalSeconds = displayedCalls.reduce((acc, c) => acc + (c.durationSeconds || 0), 0);
    const avgSeconds = total > 0 ? Math.round(totalSeconds / total) : 0;
    const conversion = total > 0 ? Math.round((confirmed / total) * 100) : 0;
    const formatDur = (s: number) => {
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      const r = s % 60;
      return r > 0 ? `${m}m ${r}s` : `${m}m`;
    };
    return {
      total,
      confirmed,
      avgDuration: formatDur(avgSeconds),
      totalDuration: formatDur(totalSeconds),
      conversion,
    };
  }, [displayedCalls]);

  const callTagOptions = useMemo(() => {
    const tagSet = new Set<string>(TRACKED_TAGS as readonly string[]);
    tagSet.add('other');
    return ['all', ...Array.from(tagSet)];
  }, []);

  const activeCall = useMemo(() => {
    if (!feedbackModal.callId) {
      return null;
    }
    return calls.find((call) => call.id === feedbackModal.callId) ?? null;
  }, [calls, feedbackModal.callId]);

  const activeSummaryCall = useMemo(() => {
    if (!summaryModalCallId) {
      return null;
    }
    return calls.find((call) => call.id === summaryModalCallId) ?? null;
  }, [calls, summaryModalCallId]);

  const modalCallerName = activeCall ? deriveCallerName(activeCall) : null;
  const modalSummary = activeCall?.summary ?? '';
  const summaryModalCallerName = activeSummaryCall ? deriveCallerName(activeSummaryCall) : null;
  const summaryModalContent = activeSummaryCall?.summary ?? '';

  const resetFilters = useCallback(() => {
    setCallTagFilter('all');
    setStartDateInput('');
    setEndDateInput('');
    setSearchTerm('');
  }, []);

  const handleExportNegativeFeedback = useCallback(async () => {
    try {
      const blob = await downloadConfirmedBookingsCsv(garageId ?? undefined);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `negative-feedback-${garageId}.csv`;
      anchor.click();
      window.URL.revokeObjectURL(url);
    } catch {
      alert('Failed to export negative feedback');
    }
  }, [garageId]);

  const handleReasonToggle = useCallback((value: string) => {
    setFeedbackReasons((prev) => (prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]));
  }, []);

  const closeFeedbackModal = useCallback(() => {
    setFeedbackModal({ callId: null, rating: null, previous: null });
    setFeedbackReasons([]);
    setFeedbackNotes('');
  }, []);

  const closeSummaryModal = useCallback(() => {
    setSummaryModalCallId(null);
  }, []);

  const feedbackMutation = useMutation({
    mutationFn: async ({ callId, rating, reasons, notes }: FeedbackMutationVariables) => {
      const uniqueReasons = Array.from(new Set((reasons ?? []).map((reason) => reason.trim()).filter(Boolean)));
      const trimmedNotes = notes?.trim();
      return submitCallFeedback(
        callId,
        {
          rating,
          reasons: uniqueReasons,
          ...(trimmedNotes ? { notes: trimmedNotes } : {}),
        },
        garageId ?? undefined,
      );
    },
    onSuccess: ({ feedback }, variables) => {
      setRatings((prev) => ({ ...prev, [variables.callId]: variables.rating }));
      queryClient.setQueryData<CallsResponse>(callsQueryKey, (previous) => {
        if (!previous) {
          return previous;
        }
        return {
          ...previous,
          calls: previous.calls.map((call) =>
            call.id === variables.callId
              ? {
                  ...call,
                  feedback,
                }
              : call,
          ),
        };
      });
      queryClient.setQueryData<CallRecord | undefined>(
        ['call-detail', garageId, variables.callId],
        (previousCall) => {
          if (!previousCall) {
            return previousCall;
          }
          return {
            ...previousCall,
            feedback,
          };
        },
      );
      if (garageId) {
        queryClient.invalidateQueries({ queryKey: ['calls', garageId], exact: false });
        queryClient.invalidateQueries({ queryKey: ['call-detail', garageId, variables.callId] });
      }
      closeFeedbackModal();
    },
    onError: (error, variables) => {
      setRatings((prev) => {
        const next = { ...prev };
        if (variables.previousRating) {
          next[variables.callId] = variables.previousRating;
        } else {
          delete next[variables.callId];
        }
        return next;
      });
      // eslint-disable-next-line no-console
      console.error('Failed to save call feedback', error);
    },
  });

  const handleRatingClick = useCallback(
    (callId: string, rating: 'up' | 'down') => {
      const previous = ratings[callId] ?? null;
      const call = calls.find((entry) => entry.id === callId);
      const existingFeedback = call?.feedback;
      const baselineReasons =
        existingFeedback && existingFeedback.rating === rating ? [...(existingFeedback.reasons ?? [])] : [];
      const baselineNotes =
        existingFeedback && existingFeedback.rating === rating ? existingFeedback.notes ?? '' : '';

      feedbackMutation.reset();
      setRatings((prev) => ({ ...prev, [callId]: rating }));

      if (rating === 'up') {
        setFeedbackModal({ callId: null, rating: null, previous: null });
        setFeedbackReasons([]);
        setFeedbackNotes('');
        feedbackMutation.mutate({
          callId,
          rating,
          reasons: [],
          notes: '',
          previousRating: previous,
        });
        return;
      }

      setFeedbackModal({ callId, rating, previous });
      setFeedbackReasons(baselineReasons);
      setFeedbackNotes(baselineNotes);
    },
    [ratings, calls, feedbackMutation],
  );

  const handleFeedbackCancel = useCallback(() => {
    setRatings((prev) => {
      if (!feedbackModal.callId) {
        return prev;
      }
      const next = { ...prev };
      if (feedbackModal.previous) {
        next[feedbackModal.callId] = feedbackModal.previous;
      } else {
        delete next[feedbackModal.callId];
      }
      return next;
    });
    feedbackMutation.reset();
    closeFeedbackModal();
  }, [feedbackModal, closeFeedbackModal, feedbackMutation]);

  const handleFeedbackConfirm = useCallback(() => {
    if (!feedbackModal.callId || !feedbackModal.rating || feedbackMutation.isPending) {
      return;
    }

    const variables: FeedbackMutationVariables = {
      callId: feedbackModal.callId,
      rating: feedbackModal.rating,
      reasons: [...feedbackReasons],
      notes: feedbackNotes,
      previousRating: feedbackModal.previous,
    };

    feedbackMutation.mutate(variables);
  }, [feedbackModal, feedbackMutation, feedbackReasons, feedbackNotes]);

  const isSavingFeedback = feedbackMutation.isPending;
  const pendingFeedbackCallId = feedbackMutation.variables?.callId ?? null;
  const feedbackErrorMessage = feedbackMutation.isError
    ? feedbackMutation.error instanceof Error
      ? feedbackMutation.error.message
      : 'Failed to submit feedback. Please try again.'
    : null;

  const handleSummaryOpen = useCallback((callId: string) => {
    setSummaryModalCallId(callId);
  }, []);

  const handleViewDetails = useCallback(
    (callId: string) => {
      router.push(`/calls/${callId}`);
    },
    [router],
  );

  const handleLoadRecording = useCallback(
    async (callId: string) => {
      if (loadingRecordings.has(callId)) {
        return;
      }

      setLoadingRecordings((prev) => new Set(prev).add(callId));
      setRecordingErrors((prev) => {
        const next = { ...prev };
        delete next[callId];
        return next;
      });

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

        // Update the call in the query cache
        queryClient.setQueryData<CallsResponse>(callsQueryKey, (previous) => {
          if (!previous) {
            return previous;
          }
          return {
            ...previous,
            calls: previous.calls.map((call) =>
              call.id === callId ? { ...call, recordingUrl: data.recordingUrl } : call,
            ),
          };
        });
      } catch (error) {
        console.error('Error fetching recording:', error);
        setRecordingErrors((prev) => ({
          ...prev,
          [callId]: error instanceof Error ? error.message : 'Failed to fetch recording',
        }));
      } finally {
        setLoadingRecordings((prev) => {
          const next = new Set(prev);
          next.delete(callId);
          return next;
        });
      }
    },
    [loadingRecordings, queryClient, callsQueryKey],
  );

  if (!garageId) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-800">
        Garage not selected. Log out and sign in again to choose a garage.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">Call Activity</h1>
        <p className="text-sm text-slate-500">Monitor interactions from your ReceptionMate AI voice agent.</p>
      </div>

      {/* KPI summary strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Total calls</div>
          <div className="mt-3 text-3xl font-semibold text-slate-900">{query.isLoading ? '—' : summaryStats.total}</div>
          <p className="mt-1 text-xs text-slate-500">In the selected filter</p>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-emerald-700">Confirmed bookings</div>
          <div className="mt-3 text-3xl font-semibold text-emerald-700">{query.isLoading ? '—' : summaryStats.confirmed}</div>
          <p className="mt-1 text-xs text-slate-500">Calls that captured a booking</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Avg duration</div>
          <div className="mt-3 text-3xl font-semibold text-slate-900">{query.isLoading ? '—' : summaryStats.avgDuration}</div>
          <p className="mt-1 text-xs text-slate-500">Per call</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Total time</div>
          <div className="mt-3 text-3xl font-semibold text-slate-900">{query.isLoading ? '—' : summaryStats.totalDuration}</div>
          <p className="mt-1 text-xs text-slate-500">Combined call time</p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-900/5">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Recent calls</h2>
            <p className="text-xs text-slate-500">Search, filter and listen back — newest first.</p>
          </div>
          {!query.isLoading && summaryStats.total > 0 ? (
            <span className="hidden rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-200 sm:inline-flex">
              {summaryStats.total} call{summaryStats.total === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-700 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-slate-500">Call Tag</span>
              <select
                value={callTagFilter}
                onChange={(event) => setCallTagFilter(event.target.value)}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:border-brand-600 focus:outline-none"
              >
                {callTagOptions.map((type) => (
                  <option key={type} value={type}>
                    {type === 'all' ? 'All Calls' : formatCallTag(type)}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-slate-500">From</span>
              <input
                type="date"
                value={startDateInput}
                onChange={(event) => setStartDateInput(event.target.value)}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:border-brand-600 focus:outline-none"
              />
            </label>

            <label className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-slate-500">To</span>
              <input
                type="date"
                value={endDateInput}
                onChange={(event) => setEndDateInput(event.target.value)}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:border-brand-600 focus:outline-none"
                min={startDateInput || undefined}
              />
            </label>
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-slate-500">Search</span>
              <input
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder={'e.g. "MOT" AND (booking OR estimate)'}
                title="Supports AND, OR, NOT and quoted phrases"
                className="w-56 rounded-md border border-slate-300 bg-white px-3 py-1 text-sm text-slate-900 focus:border-brand-600 focus:outline-none"
              />
            </label>
            {filtersActive ? (
              <button
                type="button"
                onClick={resetFilters}
                className="text-xs font-medium text-brand-600 hover:text-brand-700"
              >
                Clear filters
              </button>
            ) : null}
            <span className="text-xs uppercase tracking-wide text-slate-500">
              {query.isLoading
                ? 'Loading…'
                : `${displayedCalls.length} result${displayedCalls.length === 1 ? '' : 's'}`}
            </span>
            <button
              type="button"
              onClick={handleExportNegativeFeedback}
              className="rounded-md border border-slate-700 bg-slate-900/80 px-3 py-1 text-xs font-medium text-slate-300 hover:border-slate-500 hover:text-slate-100"
            >
              Export negative feedback
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-white text-xs uppercase tracking-widest text-slate-500">
              <tr>
                <th className="px-5 py-3 text-left font-medium">Caller</th>
                <th className="px-5 py-3 text-left font-medium">From Number</th>
                <th className="px-5 py-3 text-left font-medium">Date &amp; Time</th>
                <th className="px-5 py-3 text-left font-medium">Tag</th>
                <th className="px-5 py-3 text-left font-medium">Recording</th>
                <th className="px-5 py-3 text-left font-medium">Summary</th>
                <th className="px-5 py-3 text-left font-medium">Details</th>
                <th className="px-5 py-3 text-left font-medium">Rating</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {query.isLoading ? (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-slate-500">
                    Loading calls…
                  </td>
                </tr>
              ) : displayedCalls.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-slate-500">
                    No calls found. Adjust filters or widen your search query.
                  </td>
                </tr>
              ) : (
                displayedCalls.map((call) => {
                  const callerName = deriveCallerName(call);
                  const callerNumberRaw = deriveCallerNumber(call);
                  const formattedNumber = formatPhoneNumber(callerNumberRaw);
                  const callTag = renderCallTag(call.callType);
                  const rating = ratings[call.id] ?? null;
                  const upActive = rating === 'up';
                  const downActive = rating === 'down';
                  const ratingDisabled = isSavingFeedback && pendingFeedbackCallId === call.id;
                  const thumbBaseClass =
                    'inline-flex h-9 w-9 items-center justify-center rounded-full border bg-white text-slate-500 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-2 focus:ring-offset-white';
                  return (
                    <tr key={call.id} className="hover:bg-slate-50">
                      <td className="px-5 py-3 align-top text-slate-900">
                        <span className="font-semibold tracking-tight text-slate-900" title={callerName}>
                          {callerName}
                        </span>
                      </td>
                      <td className="px-5 py-3 align-top text-slate-700" title={formattedNumber}>
                        {formattedNumber}
                      </td>
                      <td className="px-5 py-3 align-top text-slate-700">{formatDate(call.createdAt)}</td>
                      <td className="px-5 py-3 align-top text-slate-900">{callTag}</td>
                      <td className="px-5 py-3 align-top text-slate-700">
                        {call.recordingUrl ? (
                          <audio
                            src={
                              call.recordingUrl.startsWith('/internal-api/')
                                ? call.recordingUrl
                                : `/internal-api/calls/${call.id}/recording/audio`
                            }
                            controls
                            className="h-8"
                            style={{ width: '200px' }}
                          />
                        ) : call.customerPhone ? (
                          <div className="space-y-1">
                            <button
                              type="button"
                              onClick={() => handleLoadRecording(call.id)}
                              disabled={loadingRecordings.has(call.id)}
                              className="rounded-md border border-slate-300 px-2 py-1 text-xs text-brand-600 hover:border-slate-500 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {loadingRecordings.has(call.id) ? 'Loading...' : 'Load Recording'}
                            </button>
                            {recordingErrors[call.id] && (
                              <p className="text-xs text-rose-600">{recordingErrors[call.id]}</p>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 align-top">
                        {call.summary?.trim() ? (
                          <button
                            type="button"
                            onClick={() => handleSummaryOpen(call.id)}
                            className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1 text-xs font-semibold text-brand-600 transition-colors hover:border-slate-500 hover:text-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-2 focus:ring-offset-white"
                          >
                            View Summary
                          </button>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 align-top">
                        <a
                          href={`/calls/${call.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1 text-xs font-semibold text-brand-600 transition-colors hover:border-slate-500 hover:text-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-2 focus:ring-offset-white"
                        >
                          View Details
                        </a>
                      </td>
                      <td className="px-5 py-3 align-top">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleRatingClick(call.id, 'up')}
                            disabled={ratingDisabled}
                            className={cn(
                              thumbBaseClass,
                              ratingDisabled ? 'cursor-not-allowed opacity-60' : null,
                              upActive
                                ? 'border-emerald-400 bg-emerald-500/10 text-emerald-300 shadow-inner shadow-emerald-500/40'
                                : 'border-slate-300 hover:border-emerald-300/70 hover:text-emerald-200',
                            )}
                            aria-pressed={upActive}
                            aria-label="Rate call positively"
                          >
                            <ThumbIcon direction="up" active={upActive} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRatingClick(call.id, 'down')}
                            disabled={ratingDisabled}
                            className={cn(
                              thumbBaseClass,
                              ratingDisabled ? 'cursor-not-allowed opacity-60' : null,
                              downActive
                                ? 'border-rose-400 bg-rose-50 text-rose-300 shadow-inner shadow-rose-500/40'
                                : 'border-slate-300 hover:border-rose-300/70 hover:text-rose-800',
                            )}
                            aria-pressed={downActive}
                            aria-label="Rate call negatively"
                          >
                            <ThumbIcon direction="down" active={downActive} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        {pagination && pagination.totalPages > 1 && (
          <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-6">
            <div className="text-sm text-slate-500">
              Showing page {pagination.page} of {pagination.totalPages} ({pagination.total} total calls)
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1 || query.isLoading}
                className={cn(
                  'rounded-md border px-4 py-2 text-sm font-medium transition-colors',
                  currentPage === 1 || query.isLoading
                    ? 'cursor-not-allowed border-slate-200 text-slate-600'
                    : 'border-slate-300 text-slate-700 hover:border-brand-600 hover:text-brand-600',
                )}
              >
                Previous
              </button>
              <div className="flex items-center gap-1">
                {/* Show page numbers */}
                {Array.from({ length: Math.min(5, pagination.totalPages) }, (_, i) => {
                  let pageNum;
                  if (pagination.totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= pagination.totalPages - 2) {
                    pageNum = pagination.totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }
                  
                  return (
                    <button
                      key={pageNum}
                      onClick={() => setCurrentPage(pageNum)}
                      disabled={query.isLoading}
                      className={cn(
                        'h-10 w-10 rounded-md text-sm font-medium transition-colors',
                        currentPage === pageNum
                          ? 'bg-brand-600 text-white'
                          : 'border border-slate-300 text-slate-700 hover:border-brand-600 hover:text-brand-600',
                        query.isLoading && 'cursor-not-allowed opacity-50',
                      )}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => setCurrentPage(Math.min(pagination.totalPages, currentPage + 1))}
                disabled={currentPage === pagination.totalPages || query.isLoading}
                className={cn(
                  'rounded-md border px-4 py-2 text-sm font-medium transition-colors',
                  currentPage === pagination.totalPages || query.isLoading
                    ? 'cursor-not-allowed border-slate-200 text-slate-600'
                    : 'border-slate-300 text-slate-700 hover:border-brand-600 hover:text-brand-600',
                )}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {query.isError ? (
        <div className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          Failed to load calls. {query.error instanceof Error ? query.error.message : 'Please try again later.'}
        </div>
      ) : null}

      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-50 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-title"
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl shadow-black/40"
          >
            <div className="space-y-2">
              <h3 id="feedback-title" className="text-lg font-semibold text-slate-900">
                Provide feedback
              </h3>
              <p className="text-sm text-slate-500">
                Let us know what we can do to improve our AI.
              </p>
              {modalCallerName ? (
                <p className="text-sm text-slate-700">
                  Call: <span className="font-medium text-slate-900">{modalCallerName}</span>
                </p>
              ) : null}
              {modalSummary ? (
                <p className="text-xs text-slate-500" title={modalSummary}>
                  {summaryPreview(modalSummary, 24)}
                </p>
              ) : null}
            </div>

            <div className="mt-5 space-y-3">
              {FEEDBACK_OPTIONS.map((option) => {
                const checked = feedbackReasons.includes(option.value);
                return (
                  <label key={option.value} className="flex items-start gap-3 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300 bg-white text-brand-600 focus:ring-brand-500"
                      checked={checked}
                      onChange={() => handleReasonToggle(option.value)}
                      disabled={isSavingFeedback}
                    />
                    <span>{option.label}</span>
                  </label>
                );
              })}

              {feedbackReasons.includes('other') ? (
                <textarea
                  className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-500 focus:border-brand-600 focus:outline-none"
                  rows={3}
                  placeholder="Tell us more…"
                  value={feedbackNotes}
                  onChange={(event) => setFeedbackNotes(event.target.value)}
                  disabled={isSavingFeedback}
                />
              ) : null}
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleFeedbackCancel}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-500"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleFeedbackConfirm}
                disabled={isSavingFeedback}
                className={cn(
                  'rounded-md px-4 py-2 text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-2 focus:ring-offset-white',
                  isSavingFeedback
                    ? 'cursor-not-allowed bg-brand-100 text-slate-500'
                    : 'bg-brand-600 text-white hover:bg-brand-700',
                )}
                aria-busy={isSavingFeedback}
              >
                {isSavingFeedback ? 'Saving…' : 'Confirm'}
              </button>
            </div>
            {feedbackErrorMessage ? (
              <p className="mt-3 text-sm text-rose-300" role="alert" aria-live="polite">
                {feedbackErrorMessage}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {isSummaryModalOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-50 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="summary-title"
            className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl shadow-black/40"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <h3 id="summary-title" className="text-lg font-semibold text-slate-900">
                  Call Summary
                </h3>
                {summaryModalCallerName ? (
                  <p className="text-sm text-slate-700">
                    Caller: <span className="font-medium text-slate-900">{summaryModalCallerName}</span>
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={closeSummaryModal}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 text-slate-700 transition-colors hover:border-slate-500 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-600 focus:ring-offset-2 focus:ring-offset-white"
                aria-label="Close summary"
              >
                X
              </button>
            </div>

            <div className="mt-4 max-h-96 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-900">
              {summaryModalContent ? (
                <p className="whitespace-pre-line">{summaryModalContent}</p>
              ) : (
                <p>Summary unavailable for this call.</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type ThumbIconProps = {
  direction: 'up' | 'down';
  active?: boolean;
};

const ThumbIcon = ({ direction, active = false }: ThumbIconProps) => (
  <svg
    className="h-4 w-4"
    viewBox="0 0 24 24"
    fill={active ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth={1.5}
    aria-hidden="true"
  >
    <g transform={direction === 'down' ? 'rotate(180 12 12)' : undefined}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14 11V5a3 3 0 00-3-3L6.79 10.42A2 2 0 007 13v7h9.75a2 2 0 001.99-1.73l.75-6A2 2 0 0017.5 10H14z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7 13H3.5A1.5 1.5 0 002 14.5v5A1.5 1.5 0 003.5 21H7"
      />
    </g>
  </svg>
);