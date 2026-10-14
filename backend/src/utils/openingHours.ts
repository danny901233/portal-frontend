// "Is this garage open right now?" — used by the short-call callback policy so nobody is rung
// back at nine at night.
//
// Everything unparseable answers FALSE. The other reading of a missing or malformed
// weeklyOpeningHours is "always open", which would ring customers at 3am, so the ambiguity is
// resolved towards silence on purpose.
import { WEEKDAY_ORDER, type DayOfWeek } from './types.js';

const HHMM = /^(\d{1,2}):(\d{2})$/;

/** "09:30" -> 570. Null for anything that is not a real time of day. */
function toMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = HHMM.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * The weekday and minute-of-day at `at`, as observed in `timeZone`.
 *
 * Read through Intl rather than from the Date's own getters: the box runs UTC and the garages are
 * on British time, so for eight months of the year a UTC reading is an hour out — which at the
 * edges of the day is the difference between open and closed.
 */
function localParts(at: Date, timeZone: string): { day: DayOfWeek; minutes: number } | null {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const weekday = parts.find((p) => p.type === 'weekday')?.value?.toLowerCase();
  const hour = parts.find((p) => p.type === 'hour')?.value;
  const minute = parts.find((p) => p.type === 'minute')?.value;
  if (!weekday || hour === undefined || minute === undefined) return null;
  if (!(WEEKDAY_ORDER as readonly string[]).includes(weekday)) return null;

  // Some ICU versions render midnight as "24" under hour12: false.
  const h = Number(hour) % 24;
  if (!Number.isFinite(h) || !Number.isFinite(Number(minute))) return null;
  return { day: weekday as DayOfWeek, minutes: h * 60 + Number(minute) };
}

export function isWithinOpeningHours(
  hours: unknown,
  at: Date,
  timeZone = 'Europe/London',
): boolean {
  if (!hours || typeof hours !== 'object' || Array.isArray(hours)) return false;

  const now = localParts(at, timeZone);
  if (!now) return false;

  const entry = (hours as Record<string, unknown>)[now.day];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;

  const day = entry as Record<string, unknown>;
  if (day.closed !== false) return false; // absent or true both mean closed

  const open = toMinutes(day.open);
  const close = toMinutes(day.close);
  if (open === null || close === null) return false;
  if (close <= open) return false; // nonsense window; refuse rather than guess

  return now.minutes >= open && now.minutes < close;
}
