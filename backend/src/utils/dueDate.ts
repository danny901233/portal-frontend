/**
 * Parsing DMS-exported due dates.
 *
 * Garages export from whatever system they run, so the CSV can carry 03/08/2026, 2026-08-03,
 * 3 Aug 2026, 03-08-26 and more. The reminder scheduler needs a real date to work from.
 *
 * Two rules, both deliberate:
 *  - UK ordering wins. 03/08/2026 is 3 August, never 8 March. Every garage here is UK-based and
 *    an American reading would silently message people five months early.
 *  - Ambiguity is rejected, not guessed. Anything we cannot read confidently returns null, the
 *    row is skipped and reported back to the garage. A reminder on the wrong day is worse than
 *    no reminder — it tells the customer their MOT is due when it isn't.
 */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/** Two-digit years: 26 -> 2026. Anything 70+ is treated as 19xx, which is never a valid due date. */
function fullYear(y: number): number {
  if (y >= 1000) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

function build(year: number, monthIndex: number, day: number): Date | null {
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(fullYear(year), monthIndex, day, 12, 0, 0));
  // Reject rolled-over dates (31 February becoming 3 March).
  if (d.getUTCDate() !== day || d.getUTCMonth() !== monthIndex) return null;
  return d;
}

export function parseDueDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // ISO first — unambiguous. 2026-08-03
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return build(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // Day-first numeric. 03/08/2026, 3-8-26, 03.08.2026
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    // A first field over 12 can only be a day, which confirms the ordering. If BOTH are <= 12 we
    // still read it day-first (UK), which is the correct call for these garages.
    if (month > 12) return null; // e.g. 03/15/2026 — an American export we must not misread
    return build(Number(m[3]), month - 1, day);
  }

  // Textual month, either order. "3 Aug 2026", "Aug 3 2026", "3rd August 2026"
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?\s+(\d{2,4})$/);
  if (m) {
    const mi = MONTHS[m[2].toLowerCase()];
    if (mi === undefined) return null;
    return build(Number(m[3]), mi, Number(m[1]));
  }
  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/);
  if (m) {
    const mi = MONTHS[m[1].toLowerCase()];
    if (mi === undefined) return null;
    return build(Number(m[3]), mi, Number(m[2]));
  }

  return null;
}

/** Whole days from today (UTC midday, matching build()) until the due date. Negative = overdue. */
export function daysUntil(due: Date, now: Date = new Date()): number {
  const a = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((a - b) / 86_400_000);
}
