/**
 * What time of day did the customer ask for — and should it follow them to a new date?
 *
 * The parser this replaces matched any bare one- or two-digit number anywhere in a message, with
 * every qualifier optional. So Laura Lyons' house number became an appointment time: "2 Yoells
 * Crescent PO8 9SH" was stored as 14:00, every "2nd November" she then typed was rewritten as
 * "2nd November past 2pm", and Speedy Spanners' drop-off diary — one slot a day at 08:30 — could
 * never satisfy it. Three identical rounds later the agent announced the booking anyway and
 * nothing reached the diary (19 Oct 2026, conversation cmvfkwuwu04ixvx116nulnnab).
 *
 * A number is only a time if it is written like one: with am/pm, with minutes, or introduced by a
 * word that can only mean a time ("after 5", "from 3", "at 9"). Everything else a garage customer
 * types — house numbers, ordinal dates, postcodes, phone numbers, mileages, registrations — is
 * left alone, because a time nobody asked for is worse than no time at all.
 */

/** "any time", "earliest", "whenever" — the customer has no preference. */
export function clearsTimePreference(message: string): boolean {
  return /\b(any\s*time|anytime|earliest|soonest|don'?t\s*mind|whenever|no\s*preference|flexible)\b/i
    .test(String(message || ''));
}

const PERIOD = /\b(morning|afternoon|evening)\b/i;

// 5pm · 5:30pm · 17:30 · 9:30. A meridiem or minutes make it a clock time on its own.
const EXPLICIT_TIME = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/i;

// "after 5", "from 3", "at 9", "around 2", "past 4", "by 6" — the qualifier is what makes the
// bare number a time.
//
// The qualifier is not enough on its own: "collect from 2 Yoells Crescent" reads exactly like
// "collect from 2" until you look at what follows the number. So a bare hour must END the thought
// — the message, a clause, or one of the few fillers that trail a time — and anything else after
// it (a street, "thousand miles", a surname) means it was never a time.
const HOUR_TRAILER = "(?=\\s*$|\\s*[.,;!?]|\\s+(?:o'?clock|onwards?|ish|please|pls|thanks?|thank"
  + '|ta|ok|okay|or|and|if|today|tomorrow|would|works?|work|is|fine|latest|earliest|am|pm)\\b)';
const QUALIFIED_HOUR = new RegExp(
  `\\b(?:past|after|from|around|at|by)\\s+(\\d{1,2})(?!\\s*(?:st|nd|rd|th)\\b)(?!\\d)${HOUR_TRAILER}`,
  'i',
);

export function preferredTimeFromMessage(message: string): string | undefined {
  const text = String(message || '');

  const explicit = text.match(EXPLICIT_TIME);
  if (explicit) {
    // Either the meridiem form (groups 1-3) or the bare clock form (groups 4-5) matched.
    const withMeridiem = explicit[3] !== undefined;
    let h = parseInt(withMeridiem ? explicit[1] : explicit[4], 10);
    const m = parseInt((withMeridiem ? explicit[2] : explicit[5]) || '0', 10);
    const mer = (explicit[3] || '').toLowerCase();
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return `${h}:${String(m).padStart(2, '0')}`;
    return undefined;
  }

  const qualified = text.match(QUALIFIED_HOUR);
  if (qualified) {
    let h = parseInt(qualified[1], 10);
    // 1–6 with no am/pm means the afternoon in a booking conversation; 7–23 is taken as given.
    if (h >= 1 && h <= 6) h += 12;
    if (h >= 7 && h <= 23) return `${h}:00`;
    return undefined;
  }

  const period = text.match(PERIOD);
  return period ? period[1].toLowerCase() : undefined;
}

/**
 * The preference to match against the diary, carrying a previously stated time onto a new date
 * ("Monday instead" + 5pm → "Monday instead past 5pm") so a day change does not lose it.
 *
 * Never at a drop-off garage: there is no time to choose there, one slot a day, so carrying a time
 * forward can only make a date the diary HAS look unavailable — which is exactly what happened to
 * Laura. `dropOff` wins over everything.
 */
export function timePreferenceForMatching(
  preference: string,
  savedTime: string | undefined,
  dropOff: boolean,
): string {
  const pref = String(preference || '');
  if (dropOff || !savedTime) return pref;

  // Already names a time of its own — leave it exactly as the customer put it.
  if (EXPLICIT_TIME.test(pref) || QUALIFIED_HOUR.test(pref) || PERIOD.test(pref)) return pref;

  const label = /^\d/.test(savedTime) ? `past ${naturalTime(savedTime)}` : savedTime;
  return `${pref} ${label}`;
}

/** 17:00 → 5pm, 9:30 → 9:30am. Kept here so this module has no dependency on the agent. */
function naturalTime(timeStr: string): string {
  const [hh, mm] = String(timeStr).split(':');
  const hour = parseInt(hh, 10);
  const min = !mm || mm === '00' ? '' : `:${mm}`;
  if (hour < 12) return hour === 0 ? `12${min}am` : `${hour}${min}am`;
  if (hour === 12) return `12${min}pm`;
  return `${hour - 12}${min}pm`;
}
