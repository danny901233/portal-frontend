'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchCalls } from '../lib/api';
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

const formatDuration = (seconds: number) => {
  if (!seconds) return '0m 00s';
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  }

  return `${minutes}m ${remainingSeconds.toString().padStart(2, '0')}s`;
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
  const [error, setError] = useState<string | null>(null);
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

  const totalCalls = calls.length;
  const totalDuration = useMemo(
    () => calls.reduce((acc, call) => acc + (call.durationSeconds ?? 0), 0),
    [calls]
  );

  const averageDuration = totalCalls ? totalDuration / totalCalls : 0;

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
        label: CONFIRMED_BOOKING_CATEGORY_LABELS[category],
        count: confirmedBookingCategoryCounts[category] ?? 0,
      })),
    [confirmedBookingCategoryCounts],
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
      if (tag !== 'confirmed booking') {
        return acc;
      }
      const metrics = call.metrics ?? {};
      const valueCandidate = BOOKING_VALUE_KEYS.reduce<number | undefined>((found, key) => {
        if (found !== undefined) {
          return found;
        }
        const metricValue = metrics[key];
        if (typeof metricValue === 'number' && Number.isFinite(metricValue)) {
          return metricValue;
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
    const otherCount = callTypeCounts.other ?? 0;
    if (otherCount > 0) {
      data.push({ tag: 'other', label: TAG_LABELS.other, count: otherCount });
    }
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-50">Dashboard</h1>
          <p className="text-sm text-slate-400">
            Monitor call performance, booking conversion, and sentiment at a glance.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex flex-col text-sm">
            <label className="mb-1 text-xs uppercase tracking-wide text-slate-400">Start date</label>
            <input
              type="date"
              value={startDate}
              max={endDate}
              onChange={(event) => handleStartChange(event.target.value)}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 shadow-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/50"
            />
          </div>
          <div className="flex flex-col text-sm">
            <label className="mb-1 text-xs uppercase tracking-wide text-slate-400">End date</label>
            <input
              type="date"
              value={endDate}
              min={startDate}
              max={formatDateInput(new Date())}
              onChange={(event) => handleEndChange(event.target.value)}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 shadow-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/50"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={applyTodayRange}
              className="rounded-full border border-slate-700 px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-200 transition hover:border-sky-400 hover:text-sky-200"
            >
              Today
            </button>
            {QUICK_RANGES.map((range) => (
              <button
                key={range.label}
                type="button"
                onClick={() => applyQuickRange(range.days)}
                className="rounded-full border border-slate-700 px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-200 transition hover:border-sky-400 hover:text-sky-200"
              >
                Last {range.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      )}

      <div className="relative overflow-hidden rounded-3xl border border-emerald-500/40 bg-slate-950 px-8 py-10 shadow-[0_25px_60px_-20px_rgba(16,185,129,0.65)]">
        <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/20 via-sky-500/15 to-purple-500/20" aria-hidden />
        <div className="absolute -top-24 -right-24 h-48 w-48 rounded-full bg-emerald-400/20 blur-3xl" aria-hidden />
        <div className="relative grid gap-6 sm:grid-cols-2 sm:items-center">
          <div className="space-y-3">
            <span className="text-sm uppercase tracking-[0.35em] text-emerald-200/80">Captured Revenue</span>
            <div className="text-5xl font-semibold text-emerald-100">
              {loading ? '—' : formatCurrency(bookingRevenueTotal)}
            </div>
            <p className="mt-2 max-w-lg text-sm text-emerald-100/80">
              Total value of confirmed bookings within the selected window.
            </p>
          </div>
          <div className="flex flex-col gap-4 rounded-3xl border border-emerald-400/50 bg-emerald-500/15 px-8 py-8 text-left shadow-inner shadow-emerald-900/40">
            <div className="text-base uppercase tracking-[0.25em] text-emerald-200/80">Confirmed bookings</div>
            <div className="text-4xl font-semibold text-emerald-100">
              {loading ? '—' : callTypeCounts['confirmed booking'] ?? 0}
            </div>
            <p className="max-w-sm text-sm text-emerald-100/75">
              Count of calls tagged as confirmed bookings during this window, directly driving captured revenue.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl bg-gradient-to-br from-sky-500/10 via-sky-500/5 to-sky-500/0 p-5 shadow-sm ring-1 ring-sky-500/20">
          <div className="text-xs uppercase tracking-wide text-slate-300">Total calls</div>
          <div className="mt-3 text-3xl font-semibold text-sky-100">{loading ? '—' : totalCalls}</div>
          <p className="mt-2 text-xs text-slate-400">
            All calls captured within the selected date range.
          </p>
        </div>
        <div className="rounded-2xl bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-emerald-500/0 p-5 shadow-sm ring-1 ring-emerald-500/20">
          <div className="text-xs uppercase tracking-wide text-slate-300">Total duration</div>
          <div className="mt-3 text-3xl font-semibold text-emerald-100">
            {loading ? '—' : formatDuration(totalDuration)}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Combined talk time for every call in the selected range.
          </p>
        </div>
        <div className="rounded-2xl bg-gradient-to-br from-violet-500/10 via-violet-500/5 to-violet-500/0 p-5 shadow-sm ring-1 ring-violet-500/20">
          <div className="text-xs uppercase tracking-wide text-slate-300">Average duration</div>
          <div className="mt-3 text-3xl font-semibold text-violet-100">
            {loading ? '—' : formatDuration(averageDuration)}
          </div>
          <p className="mt-2 text-xs text-slate-400">Mean handle time for conversations in this period.</p>
        </div>
        <div className="rounded-2xl bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-amber-500/0 p-5 shadow-sm ring-1 ring-amber-500/20">
          <div className="text-xs uppercase tracking-wide text-slate-300">Top call tag</div>
          <div className="mt-3 text-3xl font-semibold text-amber-100">{loading ? '—' : mostCommonTagLabel}</div>
          <p className="mt-2 text-xs text-slate-400">Most frequent call classification in the selected window.</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-100">Call type distribution</h2>
            <span className="text-xs uppercase tracking-wide text-slate-400">By tag</span>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Tags show the purpose of each call and highlight where your team is spending time.
          </p>
          <div className="mt-6">
            {loading ? (
              <div className="text-sm text-slate-400">Loading distribution…</div>
            ) : callTypeTotal ? (
              <div className="flex flex-col items-center gap-8 lg:flex-row lg:items-stretch">
                <div className="flex justify-center lg:w-1/2">
                  <div
                    className="relative h-52 w-52 rounded-full border border-slate-800 bg-slate-950 shadow-lg shadow-slate-950/40"
                    style={{ backgroundImage: pieGradient }}
                  >
                    <div className="absolute inset-8 flex flex-col items-center justify-center rounded-full border border-slate-800 bg-slate-950/90 text-slate-100 shadow-inner shadow-black/40">
                      <span className="text-xs uppercase tracking-wide text-slate-400">Total calls</span>
                      <span className="mt-1 text-3xl font-semibold text-slate-50">{totalCalls}</span>
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
                          'flex items-center justify-between rounded-xl border border-slate-800/60 bg-slate-900/50 px-4 py-3 text-sm transition',
                          isZero ? 'opacity-60' : 'hover:border-slate-700 hover:bg-slate-900/80'
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className="h-3 w-3 rounded-full"
                            style={{ backgroundColor: color }}
                            aria-hidden
                          />
                          <span className="text-slate-100">{label}</span>
                        </div>
                        <span className="text-xs text-slate-300">{count} • {percent}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-400">No calls recorded for this range.</div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-100">Daily call volume</h2>
            <span className="text-xs uppercase tracking-wide text-slate-400">Trend</span>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Track demand patterns to understand staffing needs and campaign impact.
          </p>
          <div className="mt-6 flex items-end gap-3 overflow-x-auto pb-2">
            {loading ? (
              <div className="text-sm text-slate-400">Loading trend…</div>
            ) : dailyBuckets.length ? (
              dailyBuckets.map((bucket) => {
                const percentage = maxDailyCount ? (bucket.count / maxDailyCount) * 100 : 0;
                const height = maxDailyCount ? Math.max(6, percentage) : 6;
                const date = new Date(`${bucket.date}T00:00:00`);
                const label = date.toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                });
                return (
                  <div key={bucket.date} className="flex w-10 flex-col items-center text-xs text-slate-400">
                    <div className="flex h-40 w-full items-end justify-center overflow-hidden rounded-full bg-slate-800/80">
                      <div
                        className="w-full rounded-full bg-gradient-to-t from-sky-500 via-sky-400 to-sky-200 shadow-lg shadow-sky-900/50"
                        style={{ height: `${height}%` }}
                        title={`${bucket.count} calls on ${label}`}
                      />
                    </div>
                    <span className="mt-2 text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
                    <span className="text-[11px] text-slate-300">{bucket.count}</span>
                  </div>
                );
              })
            ) : (
              <div className="text-sm text-slate-400">No calls recorded for this range.</div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-100">Confirmed booking categories</h2>
            <span className="text-xs uppercase tracking-wide text-slate-400">Set customer info</span>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Breakdown of confirmed bookings that hit the customer info webhook, grouped by service type.
          </p>
          <div className="mt-6">
            {loading ? (
              <div className="text-sm text-slate-400">Loading breakdown…</div>
            ) : confirmedBookingTotal ? (
              <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
                <div className="flex justify-center lg:w-1/2">
                  <div
                    className="relative h-40 w-40 rounded-full border border-slate-800 bg-slate-950 shadow-lg shadow-slate-950/40"
                    style={{ backgroundImage: confirmedBookingPieGradient }}
                  >
                    <div className="absolute inset-6 flex flex-col items-center justify-center rounded-full border border-slate-800 bg-slate-950/90 text-slate-100 shadow-inner shadow-black/40">
                      <span className="text-[10px] uppercase tracking-[0.35em] text-slate-400">Confirmed</span>
                      <span className="mt-1 text-3xl font-semibold text-slate-50">{confirmedBookingTotal}</span>
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
                          'flex items-center justify-between rounded-xl border border-slate-800/60 bg-slate-900/50 px-4 py-2 text-sm transition',
                          entry.count === 0 ? 'opacity-60' : 'hover:border-slate-700 hover:bg-slate-900/80',
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className="h-3 w-3 rounded-full"
                            style={{ backgroundColor: color }}
                            aria-hidden
                          />
                          <span className="text-slate-100">{entry.label}</span>
                        </div>
                        <span className="text-xs text-slate-300">
                          {entry.count} • {percent}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-400">
                No confirmed bookings recorded for this range.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-semibold text-slate-100">Tag spotlight</h2>
        <p className="mt-1 text-sm text-slate-400">
          Quick overview of how often each tag is used. Use this to prioritise scripts and team training.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {(TRACKED_TAGS as readonly string[]).map((tag) => {
            const count = callTypeCounts[tag] ?? 0;
            return (
              <span
                key={tag}
                className={cn(
                  'inline-flex min-w-[140px] items-center justify-between gap-2 rounded-full px-4 py-2 text-sm font-medium text-slate-100 shadow shadow-black/20',
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
                'inline-flex min-w-[140px] items-center justify-between gap-2 rounded-full px-4 py-2 text-sm font-medium text-slate-100 shadow shadow-black/20',
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
