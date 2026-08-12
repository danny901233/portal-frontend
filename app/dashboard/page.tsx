'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { downloadConfirmedBookingsCsv, fetchCalls, fetchAgentConfiguration } from '../lib/api';
import type { CallRecord, ConfirmedBookingCategory } from '../types';
import { cn } from '../lib/utils';
import { useBranchScope } from '../lib/branchScope';
import {
  TAG_LABELS,
  TRACKED_TAGS,
  TAG_COLORS,
  normaliseCallTag,
} from '../lib/callTags';
import MessageStatsWidget from '../components/MessageStatsWidget';
import SmsStatsWidget from '../components/SmsStatsWidget';
import { getSessionToken } from '../lib/auth';
import { useLang } from '@/app/i18n/LocaleProvider';

type CallTypeTag = (typeof TRACKED_TAGS)[number] | 'other';
type CallTypeChartEntry = {
  tag: CallTypeTag;
  label: string;
  count: number;
};

// Recent chat conversation (subset of the /conversations list) for the activity feed.
type ConversationRow = {
  id: string;
  platform?: string;
  customerName?: string | null;
  customerPhone?: string | null;
  lastMessage?: string | null;
  lastMessageAt?: string | null;
  createdAt?: string | null;
  unreadCount?: number;
};

// A unified "Recent activity" row — either a call or a chat conversation.
type ActivityItem = {
  kind: 'call' | 'chat';
  id: string;
  name: string;
  ts: number;
  tag?: string;
  preview?: string;
  platform?: string;
  unread?: number;
};

const EMPTY_PIE_COLOR = '#1e293b';

const BOOKING_VALUE_KEYS = [
  'bookingValue',
  'bookedValue',
  'bookingAmount',
  'confirmedBookingValue',
  'bookingTotal',
  'revenue',
  'totalValue',
  'value',
] as const;

const CONFIRMED_BOOKING_CATEGORIES = ['service', 'diagnostic', 'mot', 'other'] as const;
const CONFIRMED_BOOKING_CATEGORY_LABELS: Record<ConfirmedBookingCategory, string> = {
  service: 'Service',
  diagnostic: 'Diagnostic',
  mot: 'MOT',
  other: 'Other',
};
const CONFIRMED_BOOKING_CATEGORY_LABELS_FR: Record<ConfirmedBookingCategory, string> = {
  service: 'Entretien',
  diagnostic: 'Diagnostic',
  mot: 'Contrôle technique',
  other: 'Autre',
};
const CONFIRMED_BOOKING_CATEGORY_COLORS: Record<ConfirmedBookingCategory, string> = {
  service: '#38bdf8',
  diagnostic: '#a855f7',
  mot: '#f97316',
  other: '#64748b',
};

const QUICK_RANGES = [
  { label: '7 days', days: 7 },
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
];

type DateRange = {
  start: string;
  end: string;
};

type DailyBucket = {
  date: string;
  count: number;
};

const formatDateInput = (date: Date) => date.toISOString().slice(0, 10);

const toIsoRangeBoundary = (date: string, boundary: 'start' | 'end') => {
  if (!date) return undefined;
  const suffix = boundary === 'start' ? 'T00:00:00.000' : 'T23:59:59.999';
  return new Date(`${date}${suffix}`).toISOString();
};

// Static waveform bar heights (%) for the mobile Home "on duty" hero.
const WAVE_BARS = [30, 55, 80, 45, 90, 60, 74, 40, 86, 50, 70, 34, 60, 88, 44, 66, 52, 78];

const prettifyUKNumber = (raw: string): string => {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+44') && digits.length === 13) {
    const rest = digits.slice(3);
    return `0${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`;
  }
  return raw;
};

const formatCurrency = (value: number) => {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(value);
};

const buildDateRange = ({ start, end }: DateRange): DailyBucket[] => {
  const buckets: DailyBucket[] = [];
  if (!start || !end) {
    return buckets;
  }

  const cursor = new Date(`${start}T00:00:00`);
  const final = new Date(`${end}T00:00:00`);

  while (cursor <= final) {
    const key = formatDateInput(cursor);
    buckets.push({ date: key, count: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  return buckets;
};

export default function DashboardPage() {
  const lang = useLang();
  const router = useRouter();
  const c = {
    en: {
      title: 'Dashboard',
      subtitle: 'Monitor call performance, booking conversion, and sentiment at a glance.',
      startDate: 'Start date',
      endDate: 'End date',
      today: 'Today',
      last: (label: string) => `Last ${label}`,
      range7: '7 days',
      range14: '14 days',
      range30: '30 days',
      preparingCsv: 'Preparing CSV…',
      downloadCsv: 'Download confirmed bookings CSV',
      capturedRevenue: 'Captured Revenue',
      capturedRevenueHint: 'Total value of confirmed bookings within the selected window.',
      confirmedBookings: 'Confirmed bookings',
      confirmedBookingsHint:
        'Count of calls tagged as confirmed bookings during this window, directly driving captured revenue.',
      totalCalls: 'Total calls',
      totalCallsHint: 'All calls captured within the selected date range.',
      totalDuration: 'Total duration',
      totalDurationHint: 'Combined call time for all calls in this period.',
      topCallTag: 'Top call tag',
      topCallTagHint: 'Most frequent call classification in the selected window.',
      callTypeDistribution: 'Call type distribution',
      byTag: 'By tag',
      callTypeDistributionHint:
        'Tags show the purpose of each call and highlight where your team is spending time.',
      loadingDistribution: 'Loading distribution…',
      totalCallsCenter: 'Total calls',
      noCallsRange: 'No calls recorded for this range.',
      dailyCallVolume: 'Daily call volume',
      trend: 'Trend',
      dailyCallVolumeHint: 'Track demand patterns to understand staffing needs and campaign impact.',
      loadingTrend: 'Loading trend…',
      callsOn: (count: number, label: string) => `${count} calls on ${label}`,
      confirmedBookingCategories: 'Confirmed booking categories',
      setCustomerInfo: 'Set customer info',
      confirmedBookingCategoriesHint:
        'Breakdown of confirmed bookings that hit the customer info webhook, grouped by service type.',
      loadingBreakdown: 'Loading breakdown…',
      confirmed: 'Confirmed',
      noConfirmedRange: 'No confirmed bookings recorded for this range.',
      tagSpotlight: 'Tag spotlight',
      tagSpotlightHint:
        'Quick overview of how often each tag is used. Use this to prioritise scripts and team training.',
      showMoreInsights: 'Show more insights',
      hideInsights: 'Hide insights',
    },
    fr: {
      title: 'Tableau de bord',
      subtitle:
        'Suivez en un coup d’œil la performance des appels, la conversion des réservations et le ressenti.',
      startDate: 'Date de début',
      endDate: 'Date de fin',
      today: 'Aujourd’hui',
      last: (label: string) => `${label} derniers`,
      range7: '7 jours',
      range14: '14 jours',
      range30: '30 jours',
      preparingCsv: 'Préparation du CSV…',
      downloadCsv: 'Télécharger le CSV des réservations confirmées',
      capturedRevenue: 'Chiffre d’affaires capté',
      capturedRevenueHint: 'Valeur totale des réservations confirmées sur la période sélectionnée.',
      confirmedBookings: 'Réservations confirmées',
      confirmedBookingsHint:
        'Nombre d’appels marqués comme réservations confirmées sur cette période, générant directement le chiffre d’affaires capté.',
      totalCalls: 'Total des appels',
      totalCallsHint: 'Tous les appels enregistrés sur la plage de dates sélectionnée.',
      totalDuration: 'Durée totale',
      totalDurationHint: 'Temps d’appel cumulé pour tous les appels de cette période.',
      topCallTag: 'Étiquette d’appel principale',
      topCallTagHint: 'Classification d’appel la plus fréquente sur la période sélectionnée.',
      callTypeDistribution: 'Répartition des types d’appel',
      byTag: 'Par étiquette',
      callTypeDistributionHint:
        'Les étiquettes indiquent l’objet de chaque appel et montrent où votre équipe passe son temps.',
      loadingDistribution: 'Chargement de la répartition…',
      totalCallsCenter: 'Total des appels',
      noCallsRange: 'Aucun appel enregistré pour cette période.',
      dailyCallVolume: 'Volume d’appels quotidien',
      trend: 'Tendance',
      dailyCallVolumeHint:
        'Suivez les tendances de la demande pour comprendre les besoins en personnel et l’impact des campagnes.',
      loadingTrend: 'Chargement de la tendance…',
      callsOn: (count: number, label: string) => `${count} appels le ${label}`,
      confirmedBookingCategories: 'Catégories de réservations confirmées',
      setCustomerInfo: 'Infos client définies',
      confirmedBookingCategoriesHint:
        'Détail des réservations confirmées ayant déclenché le webhook d’informations client, regroupées par type de service.',
      loadingBreakdown: 'Chargement du détail…',
      confirmed: 'Confirmées',
      noConfirmedRange: 'Aucune réservation confirmée enregistrée pour cette période.',
      tagSpotlight: 'Focus sur les étiquettes',
      tagSpotlightHint:
        'Aperçu rapide de la fréquence d’utilisation de chaque étiquette. Utilisez-le pour prioriser les scripts et la formation de l’équipe.',
      showMoreInsights: 'Afficher plus de détails',
      hideInsights: 'Masquer les détails',
    },
  }[lang];
  const today = useMemo(() => new Date(), []);
  const defaultEnd = useMemo(() => formatDateInput(today), [today]);
  const defaultStart = useMemo(() => {
    const back = new Date(today);
    back.setDate(back.getDate() - 6);
    return formatDateInput(back);
  }, [today]);

  const [startDate, setStartDate] = useState<string>(defaultStart);
  const [endDate, setEndDate] = useState<string>(defaultEnd);
  // Which quick range is active (drives the mobile segmented control's highlight).
  const [rangeMode, setRangeMode] = useState<'today' | 'r7' | 'r14' | 'r30' | 'custom'>('r7');
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMessagingAccess, setHasMessagingAccess] = useState<boolean>(false);
  // Mobile-only: collapse the lower analytics (charts + tag spotlight) behind a
  // toggle so the phone dashboard is scannable. Desktop always shows everything.
  const [showMoreInsights, setShowMoreInsights] = useState<boolean>(false);
  // Agent persona for the mobile Home hero.
  const [agentName, setAgentName] = useState<string>('Leah');
  const [agentNumber, setAgentNumber] = useState<string | null>(null);
  const {
    scope,
    managedGarageIds,
    allowAllAssignedOption,
    selectedGarageId,
    assignedGarageIds,
  } = useBranchScope();
  const shouldAggregateAllBranches =
    scope === 'all' && allowAllAssignedOption && assignedGarageIds.length > 0;

  useEffect(() => {
    let isMounted = true;
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const startBoundary = toIsoRangeBoundary(startDate, 'start');
        const endBoundary = toIsoRangeBoundary(endDate, 'end');
        const filters: Parameters<typeof fetchCalls>[1] = {
          startDate: startBoundary,
          endDate: endBoundary,
          ...(shouldAggregateAllBranches ? { garageIds: assignedGarageIds } : {}),
          pageSize: 10000, // Dashboard needs all calls for accurate totals
        };
        const garageParam = shouldAggregateAllBranches ? undefined : selectedGarageId ?? undefined;
        const { calls: responseCalls } = await fetchCalls(garageParam, filters);
        if (isMounted) {
          setCalls(responseCalls);
        }
      } catch (err) {
        if (isMounted) {
          const message = err instanceof Error ? err.message : 'Failed to load dashboard data';
          setError(message);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    void fetchData();

    return () => {
      isMounted = false;
    };
  }, [endDate, assignedGarageIds, selectedGarageId, shouldAggregateAllBranches, startDate]);

  useEffect(() => {
    const checkMessagingAccess = async () => {
      if (!selectedGarageId) return;

      try {
        const token = getSessionToken();
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/api/garages/${selectedGarageId}/messaging-access`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (response.ok) {
          const data = await response.json();
          setHasMessagingAccess(data.hasMessagingAccess || false);
        }
      } catch (error) {
        console.error('Error checking messaging access:', error);
        setHasMessagingAccess(false);
      }
    };

    void checkMessagingAccess();
  }, [selectedGarageId]);

  // Recent chat conversations for the "Recent activity" feed (alongside calls).
  useEffect(() => {
    const loadConversations = async () => {
      if (!selectedGarageId || !hasMessagingAccess || shouldAggregateAllBranches) {
        setConversations([]);
        return;
      }
      try {
        const token = getSessionToken();
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/api/conversations?garageId=${selectedGarageId}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (response.ok) {
          const data = (await response.json()) as { conversations?: ConversationRow[] };
          setConversations(data.conversations ?? []);
        }
      } catch (error) {
        console.error('Error loading conversations:', error);
      }
    };
    void loadConversations();
  }, [selectedGarageId, hasMessagingAccess, shouldAggregateAllBranches]);

  // Agent name + number for the Home hero (single-branch scope only).
  useEffect(() => {
    if (!selectedGarageId || shouldAggregateAllBranches) {
      setAgentNumber(null);
      return;
    }
    let cancelled = false;
    fetchAgentConfiguration(selectedGarageId)
      .then((res) => {
        if (cancelled) return;
        const cfg = res?.configuration;
        const nm =
          (cfg?.agentName && cfg.agentName.trim()) ||
          (cfg?.voice ? cfg.voice.charAt(0).toUpperCase() + cfg.voice.slice(1) : '') ||
          'Leah';
        setAgentName(nm);
        setAgentNumber(res?.twilioNumber ?? null);
      })
      .catch(() => {
        if (!cancelled) setAgentNumber(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedGarageId, shouldAggregateAllBranches]);

  const totalCalls = calls.length;

  const todayAnswered = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const t = start.getTime();
    return calls.filter((cl) => new Date(cl.createdAt).getTime() >= t).length;
  }, [calls]);

  // "Recent activity" = recent calls + recent chat conversations, interleaved newest-first.
  const recentActivity = useMemo<ActivityItem[]>(() => {
    const callItems: ActivityItem[] = calls.map((cl) => ({
      kind: 'call',
      id: cl.id,
      name:
        (cl.customerName && cl.customerName.trim()) ||
        cl.customerPhone ||
        (lang === 'fr' ? 'Appelant inconnu' : 'Unknown caller'),
      ts: new Date(cl.createdAt).getTime(),
      tag: normaliseCallTag(cl.callType),
    }));
    const chatItems: ActivityItem[] = conversations.map((cv) => ({
      kind: 'chat',
      id: cv.id,
      name:
        (cv.customerName && cv.customerName.trim()) ||
        cv.customerPhone ||
        (lang === 'fr' ? 'Client' : 'Customer'),
      ts: new Date(cv.lastMessageAt ?? cv.createdAt ?? 0).getTime(),
      preview: cv.lastMessage ?? undefined,
      platform: cv.platform,
      unread: cv.unreadCount ?? 0,
    }));
    return [...callItems, ...chatItems].sort((a, b) => b.ts - a.ts).slice(0, 6);
  }, [calls, conversations, lang]);

  const totalDurationSeconds = useMemo(() => {
    return calls.reduce((acc, call) => acc + (call.durationSeconds || 0), 0);
  }, [calls]);

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {
      return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (remainingMinutes > 0) {
      return `${hours}h ${remainingMinutes}m`;
    }
    return `${hours}h`;
  };

  const callTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    calls.forEach((call) => {
      const raw = normaliseCallTag(call.callType);
      const tag = TRACKED_TAGS.includes(raw as (typeof TRACKED_TAGS)[number]) ? raw : 'other';
      counts[tag] = (counts[tag] ?? 0) + 1;
    });
    return counts;
  }, [calls]);

  const confirmedBookingCalls = useMemo(() => calls.filter((call) => Boolean(call.confirmedBooking)), [calls]);
  const confirmedBookingCategoryCounts = useMemo(() => {
    const counts = CONFIRMED_BOOKING_CATEGORIES.reduce<Record<ConfirmedBookingCategory, number>>((acc, category) => {
      acc[category] = 0;
      return acc;
    }, {} as Record<ConfirmedBookingCategory, number>);
    confirmedBookingCalls.forEach((call) => {
      const category = (call.confirmedBookingCategory ?? 'other') as ConfirmedBookingCategory;
      counts[category] = (counts[category] ?? 0) + 1;
    });
    return counts;
  }, [confirmedBookingCalls]);
  const confirmedBookingCategoryChartData = useMemo(
    () =>
      CONFIRMED_BOOKING_CATEGORIES.map((category) => ({
        category,
        label: (lang === 'fr'
          ? CONFIRMED_BOOKING_CATEGORY_LABELS_FR
          : CONFIRMED_BOOKING_CATEGORY_LABELS)[category],
        count: confirmedBookingCategoryCounts[category] ?? 0,
      })),
    [confirmedBookingCategoryCounts, lang],
  );
  const confirmedBookingTotal = confirmedBookingCalls.length;
  const confirmedBookingPieGradient = useMemo(() => {
    if (!confirmedBookingTotal) {
      return `conic-gradient(${EMPTY_PIE_COLOR} 0deg, ${EMPTY_PIE_COLOR} 360deg)`;
    }
    const segments = confirmedBookingCategoryChartData.filter((entry) => entry.count > 0);
    if (!segments.length) {
      return `conic-gradient(${EMPTY_PIE_COLOR} 0deg, ${EMPTY_PIE_COLOR} 360deg)`;
    }

    let currentAngle = 0;
    const stops = segments.map((entry) => {
      const angle = (entry.count / confirmedBookingTotal) * 360;
      const start = currentAngle;
      currentAngle += angle;
      const color = CONFIRMED_BOOKING_CATEGORY_COLORS[entry.category] ?? EMPTY_PIE_COLOR;
      return `${color} ${start}deg ${start + angle}deg`;
    });

    return `conic-gradient(${stops.join(', ')})`;
  }, [confirmedBookingCategoryChartData, confirmedBookingTotal]);

  const bookingRevenueTotal = useMemo(() => {
    return calls.reduce((acc, call) => {
      const tag = (call.callType ?? '').trim().toLowerCase();
      // Match any variation of "confirmed" and "booking"
      if (!tag.includes('confirmed') || !tag.includes('booking')) {
        return acc;
      }
      
      // First check if capturedRevenue exists at the top level (new format)
      if (typeof call.capturedRevenue === 'number' && Number.isFinite(call.capturedRevenue)) {
        return acc + call.capturedRevenue;
      }
      
      // Check if capturedRevenue is a string that can be parsed
      if (typeof call.capturedRevenue === 'string') {
        const parsed = parseFloat(call.capturedRevenue);
        if (Number.isFinite(parsed)) {
          return acc + parsed;
        }
      }
      
      // Try to extract price from bookingDetails text (e.g., "Date: 2026-03-02, Time: 13:30, Service: Full Service, Price: ¤289.20")
      if (typeof call.bookingDetails === 'string') {
        // Match patterns like "Price: ¤289.20", "Price: £289.20", "Total Price: ¤0.30"
        const priceMatch = call.bookingDetails.match(/(?:Total\s+)?Price:\s*[¤£$€]?(\d+(?:\.\d{2})?)/i);
        if (priceMatch && priceMatch[1]) {
          const price = parseFloat(priceMatch[1]);
          if (Number.isFinite(price)) {
            return acc + price;
          }
        }
      }
      
      // Fallback to checking metrics object (legacy format)
      const metrics = call.metrics ?? {};
      const valueCandidate = BOOKING_VALUE_KEYS.reduce<number | undefined>((found, key) => {
        if (found !== undefined) {
          return found;
        }
        const metricValue = metrics[key];
        if (typeof metricValue === 'number' && Number.isFinite(metricValue)) {
          return metricValue;
        }
        // Also try parsing strings in metrics
        if (typeof metricValue === 'string') {
          const parsed = parseFloat(metricValue);
          if (Number.isFinite(parsed)) {
            return parsed;
          }
        }
        return undefined;
      }, undefined);
      if (typeof valueCandidate === 'number' && Number.isFinite(valueCandidate)) {
        return acc + valueCandidate;
      }
      return acc;
    }, 0);
  }, [calls]);

  const callTypeChartData = useMemo<CallTypeChartEntry[]>(() => {
    const data: CallTypeChartEntry[] = TRACKED_TAGS.map((tag) => ({
      tag,
      label: TAG_LABELS[tag],
      count: callTypeCounts[tag] ?? 0,
    }));
    return data;
  }, [callTypeCounts]);

  const callTypeTotal = useMemo(
    () => callTypeChartData.reduce((acc, entry) => acc + entry.count, 0),
    [callTypeChartData]
  );

  const maxTypeCount = useMemo(
    () => Math.max(1, ...callTypeChartData.map((entry) => entry.count)),
    [callTypeChartData],
  );

  const pieGradient = useMemo(() => {
    if (!callTypeTotal) {
      return `conic-gradient(${EMPTY_PIE_COLOR} 0deg, ${EMPTY_PIE_COLOR} 360deg)`;
    }

    let currentAngle = 0;
    const segments = callTypeChartData.filter((entry) => entry.count > 0);
    if (!segments.length) {
      return `conic-gradient(${EMPTY_PIE_COLOR} 0deg, ${EMPTY_PIE_COLOR} 360deg)`;
    }

    const stops = segments.map((entry) => {
      const color = TAG_COLORS[entry.tag] ?? TAG_COLORS.other;
      const angle = (entry.count / callTypeTotal) * 360;
      const start = currentAngle;
      currentAngle += angle;
      return `${color} ${start}deg ${start + angle}deg`;
    });

    return `conic-gradient(${stops.join(', ')})`;
  }, [callTypeChartData, callTypeTotal]);

  const mostCommonTag = useMemo(() => {
    if (!callTypeChartData.length) return null;
    return callTypeChartData.reduce<{ tag: string; count: number } | null>((top, entry) => {
      if (!top || entry.count > top.count) {
        return { tag: entry.tag, count: entry.count };
      }
      return top;
    }, null);
  }, [callTypeChartData]);

  const mostCommonTagLabel = mostCommonTag ? TAG_LABELS[mostCommonTag.tag] : '—';

  const dailyBuckets = useMemo(() => {
    if (!startDate || !endDate) return [];
    const range = buildDateRange({ start: startDate, end: endDate });
    const map = new Map<string, number>();
    calls.forEach((call) => {
      const day = formatDateInput(new Date(call.createdAt));
      map.set(day, (map.get(day) ?? 0) + 1);
    });
    return range.map((bucket) => ({
      ...bucket,
      count: map.get(bucket.date) ?? 0,
    }));
  }, [calls, startDate, endDate]);

  const maxDailyCount = dailyBuckets.reduce((max, bucket) => Math.max(max, bucket.count), 0);

  const applyTodayRange = () => {
    const todayValue = formatDateInput(new Date());
    setStartDate(todayValue);
    setEndDate(todayValue);
    setRangeMode('today');
  };

  const applyQuickRange = (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (days - 1));
    setStartDate(formatDateInput(start));
    setEndDate(formatDateInput(end));
    setRangeMode(days === 7 ? 'r7' : days === 14 ? 'r14' : 'r30');
  };

  const handleStartChange = (value: string) => {
    if (!value) return;
    if (value > endDate) {
      setEndDate(value);
    }
    setStartDate(value);
    setRangeMode('custom');
  };

  const handleEndChange = (value: string) => {
    if (!value) return;
    if (value < startDate) {
      setStartDate(value);
    }
    setEndDate(value);
    setRangeMode('custom');
  };

  // Human-readable current range, e.g. "30 Jun – 6 Jul 2026" (mobile control).
  const rangeLabelText = (() => {
    if (!startDate || !endDate) return '';
    const loc = lang === 'fr' ? 'fr-FR' : 'en-GB';
    const s = new Date(`${startDate}T00:00:00`).toLocaleDateString(loc, { day: 'numeric', month: 'short' });
    const e = new Date(`${endDate}T00:00:00`).toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' });
    return startDate === endDate ? e : `${s} – ${e}`;
  })();

  const handleDownloadConfirmedBookings = async () => {
    setIsDownloading(true);
    setError(null);
    try {
      const startBoundary = toIsoRangeBoundary(startDate, 'start');
      const endBoundary = toIsoRangeBoundary(endDate, 'end');
      const filters: Parameters<typeof downloadConfirmedBookingsCsv>[1] = {
        startDate: startBoundary,
        endDate: endBoundary,
        ...(shouldAggregateAllBranches ? { garageIds: assignedGarageIds } : {}),
      };
      const garageParam = shouldAggregateAllBranches ? undefined : selectedGarageId ?? undefined;
      const blob = await downloadConfirmedBookingsCsv(garageParam, filters);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `confirmed-bookings-${startDate}-to-${endDate}.csv`;
      anchor.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to download CSV';
      setError(message);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{c.title}</h1>
          <p className="text-sm text-slate-500">
            {c.subtitle}
          </p>
        </div>
        {/* Mobile: simple range control — segmented chips, optional custom dates, slim CSV. Desktop keeps the full card. */}
        <div className="w-full md:hidden">
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {([
              { k: 'today', label: c.today, on: applyTodayRange },
              { k: 'r7', label: c.range7, on: () => applyQuickRange(7) },
              { k: 'r14', label: c.range14, on: () => applyQuickRange(14) },
              { k: 'r30', label: c.range30, on: () => applyQuickRange(30) },
              { k: 'custom', label: lang === 'fr' ? 'Personnalisé' : 'Custom', on: () => setRangeMode('custom') },
            ] as const).map((o) => (
              <button
                key={o.k}
                type="button"
                onClick={o.on}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition-colors',
                  rangeMode === o.k ? 'bg-brand-600 text-white shadow-sm' : 'bg-white text-slate-600 ring-1 ring-slate-200',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          {rangeMode === 'custom' && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <input
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => handleStartChange(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
              />
              <input
                type="date"
                value={endDate}
                min={startDate}
                max={formatDateInput(new Date())}
                onChange={(e) => handleEndChange(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
              />
            </div>
          )}
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-500">{rangeLabelText}</span>
            <button
              type="button"
              onClick={handleDownloadConfirmedBookings}
              disabled={isDownloading || loading}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 transition hover:bg-emerald-50',
                (isDownloading || loading) && 'cursor-not-allowed opacity-60',
              )}
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
              {isDownloading ? c.preparingCsv : lang === 'fr' ? 'CSV réservations' : 'Bookings CSV'}
            </button>
          </div>
        </div>

        <div className="hidden w-full flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm md:flex md:w-auto md:gap-4 md:p-4">
          <div className="flex min-w-0 flex-1 flex-col text-sm md:flex-none">
            <label className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{c.startDate}</label>
            <input
              type="date"
              value={startDate}
              max={endDate}
              onChange={(event) => handleStartChange(event.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col text-sm md:flex-none">
            <label className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{c.endDate}</label>
            <input
              type="date"
              value={endDate}
              min={startDate}
              max={formatDateInput(new Date())}
              onChange={(event) => handleEndChange(event.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
            />
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 md:w-auto">
            <button
              type="button"
              onClick={applyTodayRange}
              className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
            >
              {c.today}
            </button>
            {QUICK_RANGES.map((range) => {
              const rangeLabel =
                range.days === 7 ? c.range7 : range.days === 14 ? c.range14 : c.range30;
              return (
                <button
                  key={range.label}
                  type="button"
                  onClick={() => applyQuickRange(range.days)}
                  className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                >
                  {c.last(rangeLabel)}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={handleDownloadConfirmedBookings}
            disabled={isDownloading || loading}
            className={cn(
              'w-full rounded-lg border border-emerald-600 bg-emerald-600 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white shadow-sm transition hover:bg-emerald-700 md:w-auto',
              (isDownloading || loading) && 'cursor-not-allowed opacity-60'
            )}
          >
            {isDownloading ? c.preparingCsv : c.downloadCsv}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Mobile Home hero — the agent on duty (signature moment). Desktop keeps the revenue hero below. */}
      <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-[#3a2ec9] to-[#1f1483] p-4 text-white shadow-lg shadow-brand-600/30 md:hidden">
        <div className="flex items-center gap-3">
          <div className="relative grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/90 text-lg font-bold text-brand-700">
            {agentName.charAt(0).toUpperCase()}
            <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-emerald-400 ring-2 ring-[#241a8f]" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{agentName}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-white/75">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 motion-safe:animate-pulse" />
              On duty · answering your calls
            </div>
          </div>
        </div>
        <div className="my-3.5 flex h-7 items-end gap-[3px]" aria-hidden>
          {WAVE_BARS.map((h, i) => (
            <span key={i} className="flex-1 rounded-full bg-gradient-to-b from-[#c9beff] to-[#8f7dff]" style={{ height: `${h}%` }} />
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-white/15 pt-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-white/60">Your line</div>
            <div className="mt-0.5 truncate text-[15px] font-semibold">{agentNumber ? prettifyUKNumber(agentNumber) : 'Not assigned yet'}</div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-white/60">Answered today</div>
            <div className="mt-0.5 text-2xl font-bold tabular-nums">{loading ? '—' : todayAnswered}</div>
          </div>
        </div>
      </div>

      {/* Mobile metrics — calls handled + time saved. Revenue in the caption below. */}
      <div className="flex overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm md:hidden">
        <div className="flex-1 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{lang === 'fr' ? 'Appels traités' : 'Calls handled'}</div>
          <div className="mt-2 text-[28px] font-extrabold leading-none tracking-tight tabular-nums text-slate-900">{loading ? '—' : totalCalls}</div>
        </div>
        <div className="flex-1 border-l border-slate-200 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{lang === 'fr' ? 'Temps géré' : 'Time handled'}</div>
          <div className="mt-2 text-[28px] font-extrabold leading-none tracking-tight tabular-nums text-slate-900">{loading ? '—' : formatDuration(totalDurationSeconds)}</div>
        </div>
      </div>
      <p className="px-1 text-xs text-slate-500 md:hidden">
        {c.capturedRevenue}:{' '}
        <span className="font-semibold text-slate-700">{loading ? '—' : formatCurrency(bookingRevenueTotal)}</span>
        {' · '}
        <span className="font-semibold text-slate-700">{loading ? '—' : callTypeCounts['confirmed booking'] ?? 0}</span>{' '}
        {c.confirmedBookings.toLowerCase()}
      </p>

      {/* Mobile: calls by type as ranked bars */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:hidden">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-[15px] font-bold text-slate-900">{c.callTypeDistribution}</h3>
          <span className="text-xs font-medium text-slate-400">{lang === 'fr' ? '7 jours' : '7 days'}</span>
        </div>
        {callTypeTotal === 0 ? (
          <p className="py-2 text-sm text-slate-500">{c.noCallsRange}</p>
        ) : (
          <div className="space-y-2.5">
            {callTypeChartData
              .filter((entry) => entry.count > 0)
              .sort((a, b) => b.count - a.count)
              .map((entry) => {
                const color = TAG_COLORS[entry.tag] ?? TAG_COLORS.other;
                const pct = Math.max(6, Math.round((entry.count / maxTypeCount) * 100));
                return (
                  <div key={entry.tag} className="flex items-center gap-3">
                    <span className="w-[68px] shrink-0 truncate text-[13px] text-slate-600">{entry.label}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <span className="block h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                    </span>
                    <span className="w-6 shrink-0 text-right text-[13px] font-bold tabular-nums text-slate-900">{entry.count}</span>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {/* Mobile: recent activity preview (calls + chats interleaved) */}
      {recentActivity.length > 0 ? (
        <div className="md:hidden">
          <div className="mb-2.5 flex items-baseline justify-between px-1">
            <h3 className="text-[15px] font-bold text-slate-900">{lang === 'fr' ? 'Activité récente' : 'Recent activity'}</h3>
            <button type="button" onClick={() => router.push('/calls')} className="text-[13px] font-semibold text-brand-600">
              {lang === 'fr' ? 'Voir tout' : 'See all'}
            </button>
          </div>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            {recentActivity.map((item) => {
              const hasName = /[a-z]/i.test(item.name);
              const initials = hasName
                ? item.name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
                : '·';
              const when = new Date(item.ts).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              });
              const isCall = item.kind === 'call';
              const color = isCall
                ? TAG_COLORS[item.tag ?? 'other'] ?? TAG_COLORS.other
                : '#3f34d6'; // brand for chats
              const sub = isCall
                ? (lang === 'fr' ? 'Appel' : 'Call')
                : (item.preview?.trim() || (lang === 'fr' ? 'Message' : 'Message'));
              return (
                <button
                  key={`${item.kind}-${item.id}`}
                  type="button"
                  onClick={() => router.push(isCall ? `/calls/${item.id}` : '/messages')}
                  className="relative flex w-full items-center gap-3 border-b border-slate-100 px-3.5 py-3 text-left last:border-b-0 active:bg-slate-50"
                >
                  <span aria-hidden className="absolute inset-y-2.5 left-0 w-1 rounded-r-full" style={{ backgroundColor: color }} />
                  <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[12px] font-bold" style={{ backgroundColor: `${color}1f`, color }}>
                    {initials}
                    <span
                      aria-hidden
                      className="absolute -bottom-1 -right-1 grid h-4 w-4 place-items-center rounded-full bg-white text-slate-500 ring-1 ring-slate-200"
                    >
                      {isCall ? <PhoneGlyph /> : <ChatGlyph />}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold text-slate-900">{item.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500">
                      <span className="text-slate-400">{when}</span>
                      {' · '}
                      {sub}
                    </span>
                  </span>
                  {!isCall && (item.unread ?? 0) > 0 ? (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden />
                  ) : null}
                  <svg className="h-4 w-4 shrink-0 text-slate-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="relative hidden overflow-hidden rounded-2xl bg-brand-600 p-4 shadow-lg shadow-brand-600/20 md:block md:rounded-3xl md:px-8 md:py-10">
        <div className="absolute -top-24 -right-24 h-48 w-48 rounded-full bg-brand-400/30 blur-3xl" aria-hidden />
        <div className="absolute -bottom-24 -left-24 h-48 w-48 rounded-full bg-fuchsia-500/20 blur-3xl" aria-hidden />
        <div className="relative grid gap-3 sm:grid-cols-2 sm:items-center md:gap-6">
          <div className="space-y-1 md:space-y-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.3em] text-brand-100 md:text-xs md:tracking-[0.35em]">{c.capturedRevenue}</span>
            <div className="text-3xl font-semibold text-white md:text-5xl">
              {loading ? '—' : formatCurrency(bookingRevenueTotal)}
            </div>
            <p className="mt-2 hidden max-w-lg text-sm text-brand-100 md:block">
              {c.capturedRevenueHint}
            </p>
          </div>
          <div className="flex flex-row items-center justify-between gap-3 rounded-xl border border-white/15 bg-white/10 px-3.5 py-2.5 text-left backdrop-blur-sm md:flex-col md:items-start md:rounded-2xl md:px-7 md:py-7">
            <div className="text-xs font-semibold uppercase tracking-[0.25em] text-brand-100">{c.confirmedBookings}</div>
            <div className="text-3xl font-semibold text-white md:text-4xl">
              {loading ? '—' : callTypeCounts['confirmed booking'] ?? 0}
            </div>
            <p className="hidden max-w-sm text-sm text-brand-100/90 md:block">
              {c.confirmedBookingsHint}
            </p>
          </div>
        </div>
      </div>

      <div className="hidden grid-cols-3 gap-2 md:grid md:gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm md:rounded-2xl md:p-5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500 md:text-xs">{c.totalCalls}</div>
          <div className="mt-1 text-lg font-semibold text-slate-900 md:mt-3 md:text-3xl">{loading ? '—' : totalCalls}</div>
          <p className="mt-2 hidden text-xs text-slate-500 md:block">
            {c.totalCallsHint}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm md:rounded-2xl md:p-5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500 md:text-xs">{c.totalDuration}</div>
          <div className="mt-1 text-lg font-semibold text-slate-900 md:mt-3 md:text-3xl">{loading ? '—' : formatDuration(totalDurationSeconds)}</div>
          <p className="mt-2 hidden text-xs text-slate-500 md:block">
            {c.totalDurationHint}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm md:rounded-2xl md:p-5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500 md:text-xs">{c.topCallTag}</div>
          <div className="mt-1 text-lg font-semibold text-slate-900 md:mt-3 md:text-3xl">{loading ? '—' : mostCommonTagLabel}</div>
          <p className="mt-2 hidden text-xs text-slate-500 md:block">{c.topCallTagHint}</p>
        </div>
      </div>

      {hasMessagingAccess && selectedGarageId && !shouldAggregateAllBranches && (
        <div className="grid gap-4 md:grid-cols-2">
          <MessageStatsWidget
            garageId={selectedGarageId}
            startDate={toIsoRangeBoundary(startDate, 'start')}
            endDate={toIsoRangeBoundary(endDate, 'end')}
          />
          <SmsStatsWidget
            garageId={selectedGarageId}
            startDate={toIsoRangeBoundary(startDate, 'start')}
            endDate={toIsoRangeBoundary(endDate, 'end')}
          />
        </div>
      )}

      {/* Mobile-only toggle to reveal the analytics below. Hidden on desktop. */}
      <button
        type="button"
        onClick={() => setShowMoreInsights((v) => !v)}
        aria-expanded={showMoreInsights}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-brand-300 hover:text-brand-700 md:hidden"
      >
        {showMoreInsights ? c.hideInsights : c.showMoreInsights}
        <svg
          className={cn('h-4 w-4 transition-transform', showMoreInsights && 'rotate-180')}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <div className={cn('grid gap-4 lg:grid-cols-3', showMoreInsights ? '' : 'hidden md:grid')}>
        <div className="hidden rounded-2xl border border-slate-200 bg-white p-6 md:block">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">{c.callTypeDistribution}</h2>
            <span className="text-xs uppercase tracking-wide text-slate-500">{c.byTag}</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {c.callTypeDistributionHint}
          </p>
          <div className="mt-6">
            {loading ? (
              <div className="text-sm text-slate-500">{c.loadingDistribution}</div>
            ) : callTypeTotal ? (
              <div className="flex flex-col items-center gap-8 lg:flex-row lg:items-stretch">
                <div className="flex justify-center lg:w-1/2">
                  <div
                    className="relative h-52 w-52 rounded-full border border-slate-200 bg-slate-50 shadow-sm"
                    style={{ backgroundImage: pieGradient }}
                  >
                    <div className="absolute inset-8 flex flex-col items-center justify-center rounded-full border border-slate-200 bg-white text-slate-900 shadow-inner shadow-black/40">
                      <span className="text-xs uppercase tracking-wide text-slate-500">{c.totalCallsCenter}</span>
                      <span className="mt-1 text-3xl font-semibold text-slate-900">{totalCalls}</span>
                    </div>
                  </div>
                </div>
                <div className="flex w-full flex-1 flex-col gap-3">
                  {callTypeChartData.map(({ tag, label, count }) => {
                    const percent = callTypeTotal ? Math.round((count / callTypeTotal) * 100) : 0;
                    const color = TAG_COLORS[tag] ?? TAG_COLORS.other;
                    const isZero = count === 0;
                    return (
                      <div
                        key={tag}
                        className={cn(
                          'flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm transition',
                          isZero ? 'opacity-60' : 'hover:border-slate-300 hover:bg-white'
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className="h-3 w-3 rounded-full"
                            style={{ backgroundColor: color }}
                            aria-hidden
                          />
                          <span className="text-slate-900">{label}</span>
                        </div>
                        <span className="text-xs text-slate-700">{count} • {percent}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-500">{c.noCallsRange}</div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">{c.dailyCallVolume}</h2>
            <span className="text-xs uppercase tracking-wide text-slate-500">{c.trend}</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {c.dailyCallVolumeHint}
          </p>
          <div className="mt-6 flex items-end gap-3 overflow-x-auto pb-2">
            {loading ? (
              <div className="text-sm text-slate-500">{c.loadingTrend}</div>
            ) : dailyBuckets.length ? (
              dailyBuckets.map((bucket) => {
                const percentage = maxDailyCount ? (bucket.count / maxDailyCount) * 100 : 0;
                const height = maxDailyCount ? Math.max(6, percentage) : 6;
                const date = new Date(`${bucket.date}T00:00:00`);
                const label = date.toLocaleDateString(lang === 'fr' ? 'fr-FR' : undefined, {
                  month: 'short',
                  day: 'numeric',
                });
                return (
                  <div key={bucket.date} className="flex w-10 flex-col items-center text-xs text-slate-500">
                    <div className="flex h-40 w-full items-end justify-center overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="w-full rounded-full bg-gradient-to-t from-sky-500 via-sky-400 to-sky-200 shadow-lg shadow-sky-900/50"
                        style={{ height: `${height}%` }}
                        title={c.callsOn(bucket.count, label)}
                      />
                    </div>
                    <span className="mt-2 text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
                    <span className="text-[11px] text-slate-700">{bucket.count}</span>
                  </div>
                );
              })
            ) : (
              <div className="text-sm text-slate-500">{c.noCallsRange}</div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">{c.confirmedBookingCategories}</h2>
            <span className="text-xs uppercase tracking-wide text-slate-500">{c.setCustomerInfo}</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {c.confirmedBookingCategoriesHint}
          </p>
          <div className="mt-6">
            {loading ? (
              <div className="text-sm text-slate-500">{c.loadingBreakdown}</div>
            ) : confirmedBookingTotal ? (
              <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
                <div className="flex justify-center lg:w-1/2">
                  <div
                    className="relative h-40 w-40 rounded-full border border-slate-200 bg-slate-50 shadow-sm"
                    style={{ backgroundImage: confirmedBookingPieGradient }}
                  >
                    <div className="absolute inset-6 flex flex-col items-center justify-center rounded-full border border-slate-200 bg-white text-slate-900 shadow-inner shadow-black/40">
                      <span className="text-[10px] uppercase tracking-[0.35em] text-slate-500">{c.confirmed}</span>
                      <span className="mt-1 text-3xl font-semibold text-slate-900">{confirmedBookingTotal}</span>
                    </div>
                  </div>
                </div>
                <div className="flex flex-1 flex-col gap-2">
                  {confirmedBookingCategoryChartData.map((entry) => {
                    const percent = confirmedBookingTotal
                      ? Math.round((entry.count / confirmedBookingTotal) * 100)
                      : 0;
                    const color = CONFIRMED_BOOKING_CATEGORY_COLORS[entry.category] ?? '#ffffff';
                    return (
                      <div
                        key={entry.category}
                        className={cn(
                          'flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm transition',
                          entry.count === 0 ? 'opacity-60' : 'hover:border-slate-300 hover:bg-white',
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className="h-3 w-3 rounded-full"
                            style={{ backgroundColor: color }}
                            aria-hidden
                          />
                          <span className="text-slate-900">{entry.label}</span>
                        </div>
                        <span className="text-xs text-slate-700">
                          {entry.count} • {percent}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-500">
                {c.noConfirmedRange}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PhoneGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} className="h-2.5 w-2.5">
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7A2 2 0 0 1 22 16.9Z" />
    </svg>
  );
}

function ChatGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} className="h-2.5 w-2.5">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8 8.4 8.4 0 0 1-3.8-.9L3 20l1.4-5A8.4 8.4 0 0 1 12 3.5a8.4 8.4 0 0 1 9 8Z" />
    </svg>
  );
}
