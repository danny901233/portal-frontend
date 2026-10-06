/**
 * Callers we refuse to answer, per line.
 *
 * ── Why this is scoped per garage ───────────────────────────────────────────
 * The demo line is published on the marketing site, so it also attracts people
 * who want to play with the agent rather than evaluate it — each attempt costs
 * LiveKit, Deepgram, LLM and TTS minutes, and competes for CPU on the same box
 * as the production portal. Refusing a known nuisance caller there is sensible.
 *
 * Refusing one on a CUSTOMER'S line is not ours to do: that is their customer.
 * And a withheld number ringing a real garage is, far more often than not, a
 * real customer with caller ID off — blocking those wholesale would silently
 * lose work for every garage on the estate. So nothing here applies to a line
 * unless the line is named, and an unset variable blocks nobody at all.
 *
 * Configured by VOICE_BLOCKED_CALLERS, comma-separated, each entry either:
 *   +447361892104@<garageId>   that number, on that line only
 *   withheld@<garageId>        calls with no usable caller ID, on that line only
 *   +447361892104              that number, on every line we answer
 */

/** Values a carrier or Twilio sends in place of a number when caller ID is withheld. */
const WITHHELD_WORDS = new Set([
  'anonymous',
  'unknown',
  'unavailable',
  'restricted',
  'private',
  'blocked',
  'withheld',
]);

/**
 * Twilio's stand-in for a withheld caller: "ANONYMOUS" spelled on a keypad. It has
 * enough digits to pass for a number, so it has to be named explicitly.
 */
const ANONYMOUS_SENTINEL = '266696687';

/** The entry value that means "any caller who withheld their number". */
const WITHHELD_KEYWORD = 'withheld';

/**
 * Comparable form of a phone number: digits only, UK local numbers in international
 * form, so "+4473 6189 210 4", "07361 892104" and "+447361892104" all match.
 */
export function normaliseCaller(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) return digits.slice(2);
  // A UK national number: 0 + 10 digits (07..., 0333..., 01...).
  if (digits.startsWith('0') && digits.length === 11) return `44${digits.slice(1)}`;
  return digits;
}

/** Did this caller arrive without a usable number? */
export function isWithheldCaller(from: string | null | undefined): boolean {
  const raw = String(from ?? '').trim();
  if (!raw) return true;

  // "anonymous", "Anonymous", "sip:anonymous@anonymous.invalid" — match on the letters present.
  const letters = raw.toLowerCase().replace(/[^a-z]/g, '');
  for (const word of WITHHELD_WORDS) if (letters.includes(word)) return true;

  const digits = normaliseCaller(raw);
  if (digits === ANONYMOUS_SENTINEL) return true;
  // Too short to dial back: not a number we can attribute a call to.
  return digits.length < 7;
}

interface BlockRule {
  /** A normalised number, or WITHHELD_KEYWORD. */
  value: string;
  /** The line it applies to, or null for every line. */
  garageId: string | null;
}

function parseBlocklist(raw: string | null | undefined): BlockRule[] {
  return String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [value, garage] = entry.split('@');
      const scope = (garage ?? '').trim().toLowerCase();
      const v = value.trim().toLowerCase();
      return {
        value: v === WITHHELD_KEYWORD ? WITHHELD_KEYWORD : normaliseCaller(v),
        garageId: scope && scope !== '*' ? scope : null,
      };
    })
    .filter((rule) => rule.value !== '');
}

/**
 * Should this call be refused?
 *
 * `blocklist` defaults to the environment so callers need not thread it through; it is a
 * parameter so the rules can be tested without touching process.env.
 */
export function isBlockedCaller(
  from: string | null | undefined,
  garageId: string,
  blocklist: string | null | undefined = process.env.VOICE_BLOCKED_CALLERS,
): boolean {
  const rules = parseBlocklist(blocklist);
  if (rules.length === 0) return false;

  const line = garageId.trim().toLowerCase();
  const caller = normaliseCaller(from);
  const withheld = isWithheldCaller(from);

  return rules.some((rule) => {
    if (rule.garageId && rule.garageId !== line) return false;
    if (rule.value === WITHHELD_KEYWORD) return withheld;
    // A withheld caller has no number, so a number rule can never match one.
    return !withheld && caller !== '' && caller === rule.value;
  });
}
