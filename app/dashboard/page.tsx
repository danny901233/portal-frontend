'use client';

import { useEffect, useMemo, useState } from 'react';
import { downloadConfirmedBookingsCsv, fetchCalls } from '../lib/api';
import type { CallRecord, ConfirmedBookingCategory } from '../types';
import { cn } from '../lib/utils';
import { useBranchScope } from '../lib/branchScope';
import {
  TAG_LABELS,
  TAG_STYLES,
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
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMessagingAccess, setHasMessagingAccess] = useState<boolean>(false);
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

  const totalCalls = calls.length;

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
  };

  const applyQuickRange = (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (days - 1));
    setStartDate(formatDateInput(start));
    setEndDate(formatDateInput(end));
  };

  const handleStartChange = (value: string) => {
    if (!value) return;
    if (value > endDate) {
      setEndDate(value);
    }
    setStartDate(value);
  };

  const handleEndChange = (value: string) => {
    if (!value) return;
    if (value < startDate) {
      setStartDate(value);
    }
    setEndDate(value);
  };

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
        <div className="flex flex-wrap items-end gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col text-sm">
            <label className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{c.startDate}</label>
            <input
              type="date"
              value={startDate}
              max={endDate}
              onChange={(event) => handleStartChange(event.target.value)}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
            />
          </div>
          <div className="flex flex-col text-sm">
            <label className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{c.endDate}</label>
            <input
              type="date"
              value={endDate}
              min={startDate}
              max={formatDateInput(new Date())}
              onChange={(event) => handleEndChange(event.target.value)}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
            />
          </div>
          <div className="flex items-center gap-2">
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
              'rounded-lg border border-emerald-600 bg-emerald-600 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white shadow-sm transition hover:bg-emerald-700',
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

      <div className="relative overflow-hidden rounded-3xl bg-brand-600 px-8 py-10 shadow-lg shadow-brand-600/20">
        <div className="absolute -top-24 -right-24 h-48 w-48 rounded-full bg-brand-400/30 blur-3xl" aria-hidden />
        <div className="absolute -bottom-24 -left-24 h-48 w-48 rounded-full bg-fuchsia-500/20 blur-3xl" aria-hidden />
        <div className="relative grid gap-6 sm:grid-cols-2 sm:items-center">
          <div className="space-y-3">
            <span className="text-xs font-semibold uppercase tracking-[0.35em] text-brand-100">{c.capturedRevenue}</span>
            <div className="text-5xl font-semibold text-white">
              {loading ? '—' : formatCurrency(bookingRevenueTotal)}
            </div>
            <p className="mt-2 max-w-lg text-sm text-brand-100">
              {c.capturedRevenueHint}
            </p>
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-white/15 bg-white/10 px-7 py-7 text-left backdrop-blur-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.25em] text-brand-100">{c.confirmedBookings}</div>
            <div className="text-4xl font-semibold text-white">
              {loading ? '—' : callTypeCounts['confirmed booking'] ?? 0}
            </div>
            <p className="max-w-sm text-sm text-brand-100/90">
              {c.confirmedBookingsHint}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{c.totalCalls}</div>
          <div className="mt-3 text-3xl font-semibold text-slate-900">{loading ? '—' : totalCalls}</div>
          <p className="mt-2 text-xs text-slate-500">
            {c.totalCallsHint}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{c.totalDuration}</div>
          <div className="mt-3 text-3xl font-semibold text-slate-900">{loading ? '—' : formatDuration(totalDurationSeconds)}</div>
          <p className="mt-2 text-xs text-slate-500">
            {c.totalDurationHint}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{c.topCallTag}</div>
          <div className="mt-3 text-3xl font-semibold text-slate-900">{loading ? '—' : mostCommonTagLabel}</div>
          <p className="mt-2 text-xs text-slate-500">{c.topCallTagHint}</p>
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

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-6">
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

      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-slate-900">{c.tagSpotlight}</h2>
        <p className="mt-1 text-sm text-slate-500">
          {c.tagSpotlightHint}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {(TRACKED_TAGS as readonly string[]).map((tag) => {
            const count = callTypeCounts[tag] ?? 0;
            return (
              <span
                key={tag}
                className={cn(
                  'inline-flex min-w-[140px] items-center justify-between gap-2 rounded-full px-4 py-2 text-sm font-medium text-slate-900 shadow shadow-black/20',
                  TAG_STYLES[tag],
                )}
              >
                <span>{TAG_LABELS[tag]}</span>
                <span className="text-sm font-semibold">{loading ? '—' : count}</span>
              </span>
            );
          })}
          {callTypeCounts.other ? (
            <span
              className={cn(
                'inline-flex min-w-[140px] items-center justify-between gap-2 rounded-full px-4 py-2 text-sm font-medium text-slate-900 shadow shadow-black/20',
                TAG_STYLES.other,
              )}
            >
              <span>{TAG_LABELS.other}</span>
              <span className="text-sm font-semibold">{loading ? '—' : callTypeCounts.other}</span>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
