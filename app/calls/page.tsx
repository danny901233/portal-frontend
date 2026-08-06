'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { Calendar, Filter, Phone, PhoneCall, Search, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { fetchCalls, submitCallFeedback } from '../lib/api';
import { getGarageId } from '../lib/auth';
import { Skeleton } from '../components/Skeleton';
import {
  TRACKED_TAGS,
  TAG_COLORS,
  getCallTagLabel,
  getCallTagStyle,
  normaliseCallTag,
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

  const theCallerMatch = summary.match(/^The caller,?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),?\s/i);
  if (theCallerMatch) {
    const candidate = theCallerMatch[1].trim();
    if (candidate) {
      return candidate;
    }
  }

  const sentenceMatch = summary.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:called|spoke|Phone|contacted|requested|inquired)/i);
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
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-6 text-sm text-amber-200">
        Garage not selected. Log out and sign in again to choose a garage.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/25">
          <PhoneCall className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Call Activity</h1>
          <p className="text-sm text-slate-400">Monitor interactions from your ReceptionMate AI voice agent.</p>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 shadow-lg shadow-slate-950/40 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 md:px-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-300">
            <Filter className="h-3.5 w-3.5 text-slate-500" />
            Recent Calls
          </div>
          <span className="text-[11px] uppercase tracking-wide text-slate-500">
            {query.isLoading
              ? 'Loading…'
              : `${displayedCalls.length} result${displayedCalls.length === 1 ? '' : 's'}`}
          </span>
        </div>

        {/* Filter section — mobile-first */}
        <div className="space-y-3 border-b border-slate-800 bg-slate-900/40 p-3 md:p-4">
          {/* Search — full width with icon */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder='Search calls — try "MOT" AND (booking OR estimate)'
              title="Supports AND, OR, NOT and quoted phrases"
              className="w-full rounded-lg border border-slate-700 bg-slate-950/80 py-2 pl-9 pr-9 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Filter row — tag dropdown + dates */}
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr] sm:gap-3">
            <div className="space-y-1">
              <label className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Tag
              </label>
              <select
                value={callTagFilter}
                onChange={(event) => setCallTagFilter(event.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
              >
                {callTagOptions.map((type) => (
                  <option key={type} value={type}>
                    {type === 'all' ? 'All Calls' : formatCallTag(type)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                <Calendar className="h-3 w-3" />
                From
              </label>
              <input
                type="date"
                value={startDateInput}
                onChange={(event) => setStartDateInput(event.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                <Calendar className="h-3 w-3" />
                To
              </label>
              <input
                type="date"
                value={endDateInput}
                onChange={(event) => setEndDateInput(event.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
                min={startDateInput || undefined}
              />
            </div>
          </div>

          {filtersActive && (
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex items-center gap-1 text-xs font-medium text-sky-400 hover:text-sky-300"
            >
              <X className="h-3 w-3" />
              Clear filters
            </button>
          )}
        </div>

        {/* Mobile card list */}
        <div className="space-y-2.5 p-3 md:hidden">
          {query.isLoading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={`mskeleton-${i}`} className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="absolute left-0 top-0 h-full w-1 bg-slate-700" />
                <div className="flex items-start justify-between gap-3 pl-2">
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-2.5 w-24" />
                  </div>
                  <Skeleton className="h-5 w-14 rounded-full" />
                </div>
                <div className="mt-3 space-y-1.5 pl-2">
                  <Skeleton className="h-2.5 w-full" />
                  <Skeleton className="h-2.5 w-3/4" />
                </div>
                <div className="mt-3 flex items-center gap-2 pl-2">
                  <Skeleton className="h-8 w-20 rounded-md" />
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <Skeleton className="h-8 w-8 rounded-full" />
                </div>
              </div>
            ))
          ) : displayedCalls.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-700 px-4 py-10 text-center">
              <PhoneCall className="h-7 w-7 text-slate-500" />
              <p className="text-sm font-medium text-slate-200">No calls found</p>
              <p className="text-xs text-slate-500">Adjust filters or widen your search query.</p>
            </div>
          ) : (
            displayedCalls.map((call) => {
              const callerName = deriveCallerName(call);
              const callerNumberRaw = deriveCallerNumber(call);
              const formattedNumber = formatPhoneNumber(callerNumberRaw);
              const callTag = renderCallTag(call.callType);
              const normTag = normaliseCallTag(call.callType);
              const accentColor = TAG_COLORS[normTag] || TAG_COLORS.other;
              const rating = ratings[call.id] ?? null;
              const upActive = rating === 'up';
              const downActive = rating === 'down';
              const ratingDisabled = isSavingFeedback && pendingFeedbackCallId === call.id;
              const thumbMobileClass =
                'inline-flex h-9 w-9 items-center justify-center rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-sky-500';
              return (
                <article
                  key={`mcard-${call.id}`}
                  className="group relative overflow-hidden rounded-xl border border-slate-800 bg-gradient-to-b from-slate-900/70 to-slate-900/40 shadow-sm shadow-black/20 transition-colors active:bg-slate-900"
                >
                  {/* Tag accent stripe */}
                  <div className="absolute left-0 top-0 h-full w-1" style={{ background: accentColor }} aria-hidden />

                  <div className="p-4 pl-5">
                    <header className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-base font-semibold tracking-tight text-slate-50">{callerName}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-slate-400">
                          <span className="inline-flex items-center gap-1">
                            <Phone className="h-3 w-3 text-slate-500" />
                            {formattedNumber}
                          </span>
                          <span className="text-slate-700">•</span>
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="h-3 w-3 text-slate-500" />
                            {formatDate(call.createdAt)}
                          </span>
                        </div>
                      </div>
                      <div className="shrink-0">{callTag}</div>
                    </header>

                    {call.summary?.trim() && (
                      <p className="mt-3 line-clamp-2 rounded-md bg-slate-950/40 px-3 py-2 text-[12px] leading-relaxed text-slate-300">
                        {call.summary.trim()}
                      </p>
                    )}

                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-800/80 pt-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleViewDetails(call.id)}
                          className="inline-flex items-center rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-sky-300 transition-colors hover:border-sky-500/60 hover:text-sky-200"
                        >
                          Details
                        </button>
                        {call.summary?.trim() && (
                          <button
                            type="button"
                            onClick={() => handleSummaryOpen(call.id)}
                            className="inline-flex items-center rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-sky-300 transition-colors hover:border-sky-500/60 hover:text-sky-200"
                          >
                            Summary
                          </button>
                        )}
                        {call.recordingUrl ? (
                          <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] font-medium text-emerald-300">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            Recording
                          </span>
                        ) : call.customerPhone ? (
                          <button
                            type="button"
                            onClick={() => handleLoadRecording(call.id)}
                            disabled={loadingRecordings.has(call.id)}
                            className="rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-1.5 text-[11px] font-medium text-slate-300 hover:border-slate-500 disabled:opacity-50"
                          >
                            {loadingRecordings.has(call.id) ? '…' : 'Load rec.'}
                          </button>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleRatingClick(call.id, 'up')}
                          disabled={ratingDisabled}
                          className={cn(
                            thumbMobileClass,
                            ratingDisabled && 'opacity-60',
                            upActive
                              ? 'border-emerald-400 bg-emerald-500/15 text-emerald-300 shadow-inner shadow-emerald-500/30'
                              : 'border-slate-700 bg-slate-900/60 text-slate-500 hover:border-emerald-400/60 hover:text-emerald-300',
                          )}
                          aria-label="Rate call positively"
                        >
                          <ThumbsUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRatingClick(call.id, 'down')}
                          disabled={ratingDisabled}
                          className={cn(
                            thumbMobileClass,
                            ratingDisabled && 'opacity-60',
                            downActive
                              ? 'border-rose-400 bg-rose-500/15 text-rose-300 shadow-inner shadow-rose-500/30'
                              : 'border-slate-700 bg-slate-900/60 text-slate-500 hover:border-rose-400/60 hover:text-rose-300',
                          )}
                          aria-label="Rate call negatively"
                        >
                          <ThumbsDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>

        {/* Desktop table */}
        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-full divide-y divide-slate-800 text-sm">
            <thead className="bg-slate-900/80 text-xs uppercase tracking-widest text-slate-400">
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
            <tbody className="divide-y divide-slate-800/80">
              {query.isLoading ? (
                Array.from({ length: 8 }).map((_, rowIdx) => (
                  <tr key={`skeleton-${rowIdx}`}>
                    <td className="px-5 py-4"><Skeleton className="h-3 w-28" /></td>
                    <td className="px-5 py-4"><Skeleton className="h-3 w-24" /></td>
                    <td className="px-5 py-4"><Skeleton className="h-3 w-32" /></td>
                    <td className="px-5 py-4"><Skeleton className="h-5 w-16 rounded-full" /></td>
                    <td className="px-5 py-4"><Skeleton className="h-7 w-20 rounded-md" /></td>
                    <td className="px-5 py-4"><Skeleton className="h-3 w-full max-w-[280px]" /></td>
                    <td className="px-5 py-4"><Skeleton className="h-3 w-16" /></td>
                    <td className="px-5 py-4"><Skeleton className="h-7 w-14 rounded-md" /></td>
                  </tr>
                ))
              ) : displayedCalls.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-slate-400">
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
                    'inline-flex h-9 w-9 items-center justify-center rounded-full border bg-slate-900/60 text-slate-400 transition-colors focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 focus:ring-offset-slate-900';
                  return (
                    <tr key={call.id} className="hover:bg-slate-900/40">
                      <td className="px-5 py-3 align-top text-slate-100">
                        <span className="font-semibold tracking-tight text-slate-100" title={callerName}>
                          {callerName}
                        </span>
                      </td>
                      <td className="px-5 py-3 align-top text-slate-200" title={formattedNumber}>
                        {formattedNumber}
                      </td>
                      <td className="px-5 py-3 align-top text-slate-200">{formatDate(call.createdAt)}</td>
                      <td className="px-5 py-3 align-top text-slate-100">{callTag}</td>
                      <td className="px-5 py-3 align-top text-slate-300">
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
                              className="rounded-md border border-slate-700 px-2 py-1 text-xs text-sky-400 hover:border-slate-500 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {loadingRecordings.has(call.id) ? 'Loading...' : 'Load Recording'}
                            </button>
                            {recordingErrors[call.id] && (
                              <p className="text-xs text-rose-400">{recordingErrors[call.id]}</p>
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
                            className="inline-flex items-center rounded-md border border-slate-700 px-3 py-1 text-xs font-semibold text-sky-400 transition-colors hover:border-slate-500 hover:text-sky-300 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                          >
                            View Summary
                          </button>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 align-top">
                        <button
                          type="button"
                          onClick={() => handleViewDetails(call.id)}
                          className="inline-flex items-center rounded-md border border-slate-700 px-3 py-1 text-xs font-semibold text-sky-400 transition-colors hover:border-slate-500 hover:text-sky-300 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                        >
                          View Details
                        </button>
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
                                : 'border-slate-700 hover:border-emerald-300/70 hover:text-emerald-200',
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
                                ? 'border-rose-400 bg-rose-500/10 text-rose-300 shadow-inner shadow-rose-500/40'
                                : 'border-slate-700 hover:border-rose-300/70 hover:text-rose-200',
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
          <div className="mt-6 flex items-center justify-between border-t border-slate-800 pt-6">
            <div className="text-sm text-slate-400">
              Showing page {pagination.page} of {pagination.totalPages} ({pagination.total} total calls)
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1 || query.isLoading}
                className={cn(
                  'rounded-md border px-4 py-2 text-sm font-medium transition-colors',
                  currentPage === 1 || query.isLoading
                    ? 'cursor-not-allowed border-slate-800 text-slate-600'
                    : 'border-slate-700 text-slate-200 hover:border-sky-500 hover:text-sky-400',
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
                          ? 'bg-sky-500 text-slate-950'
                          : 'border border-slate-700 text-slate-300 hover:border-sky-500 hover:text-sky-400',
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
                    ? 'cursor-not-allowed border-slate-800 text-slate-600'
                    : 'border-slate-700 text-slate-200 hover:border-sky-500 hover:text-sky-400',
                )}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {query.isError ? (
        <div className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Failed to load calls. {query.error instanceof Error ? query.error.message : 'Please try again later.'}
        </div>
      ) : null}

      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-title"
            className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-black/40"
          >
            <div className="space-y-2">
              <h3 id="feedback-title" className="text-lg font-semibold text-slate-100">
                Provide feedback
              </h3>
              <p className="text-sm text-slate-400">
                Let us know what we can do to improve our AI.
              </p>
              {modalCallerName ? (
                <p className="text-sm text-slate-300">
                  Call: <span className="font-medium text-slate-100">{modalCallerName}</span>
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
                  <label key={option.value} className="flex items-start gap-3 text-sm text-slate-200">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-400"
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
                  className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
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
                className="rounded-md border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:border-slate-500"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleFeedbackConfirm}
                disabled={isSavingFeedback}
                className={cn(
                  'rounded-md px-4 py-2 text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 focus:ring-offset-slate-900',
                  isSavingFeedback
                    ? 'cursor-not-allowed bg-sky-500/40 text-slate-400'
                    : 'bg-sky-500 text-slate-950 hover:bg-sky-400',
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
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="summary-title"
            className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-black/40"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <h3 id="summary-title" className="text-lg font-semibold text-slate-100">
                  Call Summary
                </h3>
                {summaryModalCallerName ? (
                  <p className="text-sm text-slate-300">
                    Caller: <span className="font-medium text-slate-100">{summaryModalCallerName}</span>
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={closeSummaryModal}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-700 text-slate-300 transition-colors hover:border-slate-500 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                aria-label="Close summary"
              >
                X
              </button>
            </div>

            <div className="mt-4 max-h-96 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/80 p-4 text-sm text-slate-100">
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