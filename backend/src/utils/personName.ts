/**
 * Turning however a name was typed into something we can say to a person.
 *
 * Names reach us from campaign CSVs, garage phonebooks and live transcription, all of them typed
 * by hand over years. The field holds "Mr", "Mrs J Smith", "SMITH, John", "Mr Kris Cottrell
 * (Internal Jobs)". Taking the first word gets you "Hi Mr" — which a Great Hollands customer
 * actually received on 2026-09-02.
 */

/**
 * Garage records carry bookkeeping inside the name field: "Mr Kris Cottrell (Internal Jobs)",
 * "Stratstone Jardine Select Bracknell (Trade) - L1035". It tells the office which ledger the job
 * belongs to and means nothing to the customer, so it is stripped before the name is used to
 * greet anyone or written onto a booking.
 */
const accountAnnotation = /\s*\([^)]*\)|\s+[-\u2013]\s*[A-Z]{1,3}\d{2,}\s*$/g;

export const NAME_TITLES = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mstr', 'master', 'dr', 'prof', 'professor', 'sir', 'madam',
  'rev', 'reverend', 'lord', 'lady', 'capt', 'captain', 'major', 'sgt',
]);

/**
 * A first name safe to greet someone by, or undefined when there isn't one.
 *
 * Undefined is a real answer, not a failure: greeting with no name at all reads perfectly well,
 * and is much better than greeting with the wrong one.
 */
export function usableFirstName(raw?: string | null): string | undefined {
  const trimmed = String(raw || '').replace(accountAnnotation, '').trim();
  if (!trimmed) return undefined;

  // "SMITH, John" puts the given name AFTER the comma — taking the first word would greet them
  // by surname, which sounds like a debt collector rather than their garage.
  const source = trimmed.includes(',') ? trimmed.split(',').slice(1).join(' ') : trimmed;

  const all = source.replace(/[.]/g, ' ').split(/\s+/).filter(Boolean);
  const words = all.filter((w) => !NAME_TITLES.has(w.toLowerCase()));
  const hadTitle = words.length !== all.length;

  // "Mr Smith" is a surname, and "Hello Smith" sounds like a summons. After a title, only trust
  // the next word as a given name when something follows it too ("Dr Emily Watts" -> Emily).
  if (hadTitle && words.length < 2) return undefined;

  const candidate = words[0];
  if (!candidate) return undefined;                      // the whole field was a title
  if (candidate.length < 2) return undefined;            // an initial, not a name
  if (!/^[A-Za-z][A-Za-z'\u2019-]+$/.test(candidate)) return undefined;

  return candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();
}

/**
 * Split a full name into the parts a chat session stores, dropping titles.
 *
 * Returns an empty first name rather than a title, so a greeting falls back to a plain "Hi".
 */
export function splitPersonName(raw?: string | null): { first: string; last: string } {
  const trimmed = String(raw || '').replace(accountAnnotation, '').trim();
  if (!trimmed) return { first: '', last: '' };
  const source = trimmed.includes(',') ? trimmed.split(',').slice(1).join(' ') : trimmed;
  const words = source.split(/\s+/).filter((w) => w && !NAME_TITLES.has(w.replace(/[.]/g, '').toLowerCase()));
  const first = usableFirstName(trimmed) || '';
  const last = first
    ? words.filter((w) => w.toLowerCase() !== first.toLowerCase()).join(' ')
    : words.join(' ');
  return { first, last };
}
