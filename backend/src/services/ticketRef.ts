/**
 * The reference a customer sees on a support email.
 *
 * Threading needs SOMETHING in the subject: `In-Reply-To` is more correct but
 * plenty of mail clients drop it, and when they do the subject tag is the only
 * thing that puts a reply back on its own ticket rather than opening a new one.
 *
 * What it must not be is the ticket's sequential number. "[RM #4]" tells the
 * reader we have handled four support emails in our history, and two emails a
 * month apart tell them our monthly volume. That is nobody's business but ours.
 *
 * So the number is obfuscated into a fixed-width code — ticket 4 becomes
 * something like `[RM-K7M2QX]` — by multiplying it into a 30-bit space by an odd
 * constant. Multiplication by an odd number modulo a power of two is a bijection,
 * so every ticket maps to exactly one code and back again with no collisions and
 * no database column to store. Consecutive tickets land nowhere near each other,
 * which is the whole point.
 *
 * This is obfuscation, not encryption: someone determined could recover the
 * ordering. It exists so a customer glancing at an email learns nothing, not to
 * withstand attack — the code is not a credential and grants no access.
 */

/** Crockford-style base32: no I, L, O or U, so a code read aloud or retyped by a
 *  human does not turn into a different one. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** All arithmetic stays in 32 bits, because `Math.imul` is defined there. Mixing
 *  it with a narrower modulus silently breaks the bijection — 32 bits needs seven
 *  base32 characters. */
const SPACE = 2 ** 32;
const CODE_LEN = 7;

/** Odd, so it is coprime with a power of two and therefore invertible. */
const MULT = 0x9e3779b1 | 1;
/** Shifts the sequence off zero so ticket 1 is not a near-constant code. */
const OFFSET = 0x5f3a72c1;

/** Modular inverse of MULT modulo 2^32, by Newton's method: each step doubles the
 *  number of correct bits, so five rounds cover 32. */
function inverseOf(a: number): number {
  let inv = a;
  for (let i = 0; i < 5; i++) inv = Math.imul(inv, 2 - Math.imul(a, inv));
  return inv >>> 0;
}
const MULT_INV = inverseOf(MULT);

/** `4` -> `K7M2QXB`. Stable for the life of the ticket. */
export function encodeTicketRef(ticketNumber: number): string {
  let v = ((Math.imul(ticketNumber, MULT) >>> 0) + OFFSET) >>> 0;
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out = ALPHABET[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

/** `K7M2QXB` -> `4`, or null if the code is not one of ours. */
export function decodeTicketRef(code: string): number | null {
  const up = code.toUpperCase();
  if (up.length !== CODE_LEN) return null;

  let v = 0;
  for (const ch of up) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    v = v * 32 + i;
  }
  if (v >= SPACE) return null;

  const n = Math.imul(((v - OFFSET) % SPACE + SPACE) % SPACE, MULT_INV) >>> 0;
  // A code we never issued decodes to some arbitrary integer, so sanity-bound it
  // rather than handing the caller a ticket number from nowhere.
  return n > 0 && n < 10_000_000 ? n : null;
}

/** What goes in the subject line. */
export const ticketSubjectTag = (ticketNumber: number): string =>
  `[RM-${encodeTicketRef(ticketNumber)}]`;

/** Matches the current opaque tag and the legacy `[RM #12]` one, so threads that
 *  started before this change keep working. */
export const TICKET_TAG_RE = /\[RM[-\s#]*([0-9A-Z]{1,8})\]/i;

/** Pull a ticket number out of a subject line, whichever tag style it carries. */
export function ticketNumberFromSubject(subject: string): number | null {
  const m = TICKET_TAG_RE.exec(subject || '');
  if (!m) return null;

  const token = m[1];
  // Legacy form: the tag held the number itself.
  if (/^\d+$/.test(token) && token.length < CODE_LEN) return Number(token);
  return decodeTicketRef(token);
}

/**
 * Every ticket number a search box entry could plausibly mean.
 *
 * A search box gets whatever the person has in front of them: the reference a
 * customer read out (`RM-2SBXHMR`, or just `2SBXHMR`), the internal number they
 * can see in the portal (`7`, `#7`), or a whole subject line pasted in.
 *
 * Digits are ambiguous — the base32 alphabet includes them, so `1234567` is both
 * a plausible internal number and a well-formed reference. Rather than guess,
 * return both readings and let the query match either; at most one will exist.
 */
export function ticketNumberCandidates(input: string): number[] {
  const raw = (input || '').trim();
  if (!raw) return [];

  const out = new Set<number>();

  // A full subject line with a tag in it.
  const fromSubject = ticketNumberFromSubject(raw);
  if (fromSubject) out.add(fromSubject);

  // Otherwise treat it as a bare token: drop brackets, an RM prefix and a #.
  const token = raw
    .replace(/[[\]]/g, '')
    .replace(/^\s*RM[-\s#]*/i, '')
    .replace(/^#/, '')
    .trim();

  if (/^\d+$/.test(token)) {
    const n = Number(token);
    if (n > 0 && Number.isSafeInteger(n)) out.add(n);
  }
  const decoded = decodeTicketRef(token);
  if (decoded) out.add(decoded);

  return [...out];
}

/** Strip any of our tags, so a title or a reply subject does not accumulate them. */
export const stripTicketTag = (subject: string): string =>
  (subject || '').replace(new RegExp(TICKET_TAG_RE.source, 'gi'), '').trim();
