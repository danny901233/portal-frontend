/**
 * Turn the opening hours a garage publishes on its own website into the `weeklyOpeningHours`
 * shape the agent reads.
 *
 * Why this exists: a demo prospect's agent has to state THEIR hours, and a generic Mon-Fri
 * 08:00-17:30 fallback is not a neutral default — the agent asserts it as fact. Binley Woods
 * Service Centre was exactly this: the fallback had its agent saying "we are open Monday to
 * Friday from 08:00 to 17:30 and Saturday from 08:30 to 12:30" while their own site says
 * 08:30-17:30 and Saturday to 13:30. A garage hearing its own opening time wrong in the first
 * minute is a worse demo than a vague one.
 *
 * Deliberately conservative: it returns null rather than a guess, because the caller's fallback
 * is merely generic whereas a mis-parse is confidently wrong. Pure, and covered by
 * openingHoursText.test.ts against strings actually scraped from garage websites.
 */

// Imported rather than redeclared so this can never drift from the shape the agent is handed.
import type { WeeklyOpeningHours } from './googlePlaces.js';

type DayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const DAY_ORDER = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
] as const;

/**
 * Longest spelling first at each position, so "thursday" is not consumed as "thu" and "sun" never
 * matches inside "sunday".
 */
const DAY_WORDS: Array<[RegExp, DayIndex]> = [
  [/\bmondays?\b/, 0], [/\bmon\b/, 0],
  [/\btuesdays?\b/, 1], [/\btues\b/, 1], [/\btue\b/, 1],
  [/\bwednesdays?\b/, 2], [/\bweds\b/, 2], [/\bwed\b/, 2],
  [/\bthursdays?\b/, 3], [/\bthurs\b/, 3], [/\bthur\b/, 3], [/\bthu\b/, 3],
  [/\bfridays?\b/, 4], [/\bfri\b/, 4],
  [/\bsaturdays?\b/, 5], [/\bsats\b/, 5], [/\bsat\b/, 5],
  [/\bsundays?\b/, 6], [/\bsuns\b/, 6], [/\bsun\b/, 6],
];

const emptyWeek = (): WeeklyOpeningHours =>
  DAY_ORDER.reduce((acc, day) => {
    acc[day] = { open: null, close: null, closed: true };
    return acc;
  }, {} as WeeklyOpeningHours);

/**
 * Page source that merely CONTAINS a day name is not an opening-hours line. The website scraper's
 * regex matched `"Monitoring":{"appsWithMonitoring":[{"appId":…` because "Monitoring" starts with
 * "Mon", and `"mons":{"widgetsClientSpecMapData"` for the same reason. Parsing either would write
 * script internals into a real garage's opening times.
 */
const looksLikeMarkupOrJson = (line: string): boolean =>
  /[{}[\]\\]/.test(line)
  || (line.match(/"/g)?.length ?? 0) >= 2
  || /\b(function|var\s|widget|appid|spec|json|rgba?\()/i.test(line)
  || line.length > 160;

/** "closed" is a real answer. "by appointment" is not a reason to call a day shut. */
const CLOSED_WORDS = /\b(closed|shut)\b/;

type TimeToken = { hour: number; minute: number; meridiem: 'am' | 'pm' | null; index: number };

// 8 | 8:30 | 8.30 | 08:30, each optionally followed by am/pm. The minute separator is a colon or a
// dot because garages write both ("9am - 12.30pm", "08.00 - 17.30").
const TIME_RE = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/gi;

const readTimes = (line: string): TimeToken[] => {
  const out: TimeToken[] = [];
  for (const m of line.matchAll(TIME_RE)) {
    const hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    // A bare number over 24, or minutes over 59, is a price, a year or a phone fragment.
    if (hour > 24 || minute > 59) continue;
    const mer = m[3] ? (m[3].toLowerCase().startsWith('a') ? 'am' : 'pm') : null;
    // A bare 0 is never an opening time — usually a stray digit from a postcode or a price.
    if (hour === 0 && !m[2] && !mer) continue;
    out.push({ hour, minute, meridiem: mer, index: m.index ?? 0 });
  }
  return out;
};

/**
 * Resolve one time to 24h. The hard case is a pair carrying no am/pm at all ("8:30 - 5:00"): a
 * garage closing at five in the morning is not a thing, so a close at or before its open is pm.
 */
const to24 = (t: TimeToken, isClose: boolean, openHour24: number | null): number => {
  const h = t.hour;
  if (t.meridiem === 'pm') return h === 12 ? 12 : h + 12;
  if (t.meridiem === 'am') return h === 12 ? 0 : h;
  if (h >= 13) return h;                                      // already 24h
  if (!isClose) return h;                                     // "8" -> 08:00
  if (openHour24 !== null && h <= openHour24) return h + 12;  // "8:30 - 5:00" -> 17:00
  return h;
};

const hhmm = (h: number, m: number): string =>
  `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

type DaySpan = { days: DayIndex[]; index: number };

/** Day mentions in the order they appear, collapsing "monday - friday" into a single span. */
const readDaySpans = (line: string): DaySpan[] => {
  const hits: Array<{ day: DayIndex; index: number; end: number }> = [];
  for (const [re, day] of DAY_WORDS) {
    const m = re.exec(line);
    if (!m) continue;
    const index = m.index;
    // Keep the longest match at a position: "sat" inside "saturday" must not register twice.
    if (hits.some((h) => index >= h.index && index < h.end)) continue;
    hits.push({ day, index, end: index + m[0].length });
  }
  hits.sort((a, b) => a.index - b.index);

  const spans: DaySpan[] = [];
  for (let i = 0; i < hits.length; i += 1) {
    const next = hits[i + 1];
    const between = next ? line.slice(hits[i].end, next.index) : '';
    // "monday - friday", "mon to fri", "mon–fri", "monday through friday", and the typo'd
    // "monday: friday:" that W M Snell's site uses. Safe because the separator has to be the ONLY
    // thing between the two day names: "monday: 9-5 tuesday: 9-5" is two spans, not a range.
    if (next && /^\s*(-|to|thru|through|till|until|:)\s*:?\s*$/.test(between)) {
      const days: DayIndex[] = [];
      for (let d = hits[i].day; days.length <= 7; d = ((d + 1) % 7) as DayIndex) {
        days.push(d);
        if (d === next.day) break;
      }
      spans.push({ days, index: hits[i].index });
      i += 1;
      continue;
    }
    spans.push({ days: [hits[i].day], index: hits[i].index });
  }
  return spans;
};

export type ParsedHours = {
  hours: WeeklyOpeningHours;
  /** Days given real times — the caller's confidence signal. */
  daysResolved: number;
  /** Days named at all, so an unmentioned weekend is distinguishable from a stated closure. */
  daysMentioned: number;
};

/**
 * Parse scraped opening-hours lines into a week.
 *
 * Returns null when the result should not be trusted, which is most of the point: a garage
 * publishing only "Saturday: 09:00 - 13:30" tells us nothing about weekdays, and inventing them is
 * the exact failure this function exists to prevent.
 */
export const parseOpeningHoursText = (lines: readonly string[]): ParsedHours | null => {
  const week = emptyWeek();
  const mentioned = new Set<DayIndex>();
  const resolved = new Set<DayIndex>();

  for (const raw of lines ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    if (looksLikeMarkupOrJson(raw)) continue;

    // Entities first: scraped HTML carries "Monday &ndash; Friday", and an undecoded entity hides
    // the day range so the whole line is thrown away. Decoded here rather than in one scraper, so
    // it holds whichever scraper supplies the text.
    const line = raw
      .toLowerCase()
      .replace(/&(ndash|mdash|#8211|#8212);/g, '-')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&amp;|&#38;/g, '&')
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();

    const spans = readDaySpans(line);
    if (spans.length === 0) continue;
    const times = readTimes(line);

    for (let s = 0; s < spans.length; s += 1) {
      const span = spans[s];
      const nextIndex = s + 1 < spans.length ? spans[s + 1].index : Number.MAX_SAFE_INTEGER;
      // Times belonging to this span are those between it and the next, so
      // "monday - friday appointment only saturday 09:00 - 16:00" does not hand the weekdays
      // Saturday's times.
      const mine = times.filter((t) => t.index > span.index && t.index < nextIndex);
      const segment = line.slice(
        span.index,
        nextIndex === Number.MAX_SAFE_INTEGER ? undefined : nextIndex,
      );

      span.days.forEach((d) => mentioned.add(d));

      if (CLOSED_WORDS.test(segment)) {
        span.days.forEach((d) => {
          week[DAY_ORDER[d]] = { open: null, close: null, closed: true };
          resolved.add(d);
        });
        continue;
      }

      if (mine.length < 2) continue;

      const openH = to24(mine[0], false, null);
      const closeH = to24(mine[1], true, openH);
      // A close still at or before the open survived the pm inference, so this is not a range.
      if (closeH <= openH) continue;

      const open = hhmm(openH, mine[0].minute);
      const close = hhmm(closeH, mine[1].minute);
      span.days.forEach((d) => {
        week[DAY_ORDER[d]] = { open, close, closed: false };
        resolved.add(d);
      });
    }
  }

  // Trust gate. Weekdays are what callers ask about and what TRANSFER_HOURS_GATE keys off, so a
  // parse that never established most of the working week is not usable.
  const weekdaysResolved = ([0, 1, 2, 3, 4] as DayIndex[]).filter((d) => resolved.has(d)).length;
  if (weekdaysResolved < 4) return null;

  return { hours: week, daysResolved: resolved.size, daysMentioned: mentioned.size };
};
