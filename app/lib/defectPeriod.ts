/**
 * The time window behind the Call faults filter on /observability.
 *
 * The panel used to show a fixed "most recent" week. This lets it be read by day, by month, or
 * over everything — and keeps the month and day arithmetic in one tested place, because that
 * is where the subtle mistakes live (the 1st of the month, the turn of the year, a window that
 * ends before it starts).
 *
 * All boundaries are local to the browser, which is what someone asking for "today" means.
 */
export type DefectPeriod = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'lastMonth' | 'all';

export const DEFECT_PERIODS: { value: DefectPeriod; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'month', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'all', label: 'All time' },
];

const midnight = (d: Date): Date => {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
};

export function defectRange(period: DefectPeriod, now: Date = new Date()): [Date, Date] {
  const end = new Date(now);
  switch (period) {
    case 'today':
      return [midnight(now), end];
    case 'yesterday': {
      const startOfToday = midnight(now);
      const startOfYesterday = new Date(startOfToday);
      startOfYesterday.setDate(startOfYesterday.getDate() - 1);
      return [startOfYesterday, startOfToday];
    }
    case '7d': {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return [start, end];
    }
    case '30d': {
      const start = new Date(now);
      start.setDate(start.getDate() - 30);
      return [start, end];
    }
    case 'month': {
      // The 1st of this month, not thirty days back — "this month" on the 3rd
      // means three days, and a 30-day window would quietly include September.
      const start = midnight(now);
      start.setDate(1);
      return [start, end];
    }
    case 'lastMonth': {
      const startOfThis = midnight(now);
      startOfThis.setDate(1);
      const start = new Date(startOfThis);
      // setMonth handles December -> November of the previous year on its own.
      start.setMonth(start.getMonth() - 1);
      return [start, startOfThis];
    }
    case 'all':
      // Before the first call this system ever logged, so "all" needs no special
      // case in the query and cannot accidentally clip the earliest rows.
      return [new Date('2020-01-01T00:00:00.000Z'), end];
    default: {
      // An unrecognised period must never produce an empty window: a filter that
      // silently shows nothing reads as a clean board.
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return [start, end];
    }
  }
}
