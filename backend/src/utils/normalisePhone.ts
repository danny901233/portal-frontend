/**
 * Normalise a phone number to E.164 UK format (+44...).
 *
 * Same rules as the Twilio outbound normaliser in routes/outbound-calls.ts, pulled out
 * so caller-recognition (Tyresoft CSV ingestion, Tyresoft caller endpoint, future
 * matchers) all use ONE phone shape. Mismatched normalisation = silent zero matches.
 *
 * Returns an empty string for anything we can't normalise — Tyresoft CSVs contain
 * garbage like "1111111111111" that must not be stored as a real number.
 */
export function normalisePhone(raw: string | null | undefined): string {
  let s = (raw || '').toString().replace(/^whatsapp:/i, '').replace(/[\s\-().]/g, '');
  if (!s) return '';
  // "00" is the old international dialling prefix — 00447925715454 is a real number.
  // Tyresoft's CSV export contains these; rejecting them loses valid matches.
  if (/^00\d{8,15}$/.test(s)) s = `+${s.slice(2)}`;
  // Already +44…
  if (/^\+44\d{10}$/.test(s)) return s;
  // 44… without the +
  if (/^44\d{10}$/.test(s)) return `+${s}`;
  // UK mobile with leading 0 (07XXXXXXXXX)
  if (/^07\d{9}$/.test(s)) return `+44${s.slice(1)}`;
  // UK landline / short mobile with leading 0
  if (/^0\d{9,10}$/.test(s)) return `+44${s.slice(1)}`;
  // UK mobile missing the leading 0 (common in CSV exports from PMS systems)
  // 10 digits starting 7X… — treat as UK mobile with the 0 dropped.
  if (/^7\d{9}$/.test(s)) return `+44${s}`;
  // Already-plus international
  if (/^\+\d{8,15}$/.test(s)) return s;
  // Garbage — same digit repeated, way too long, way too short.
  return '';
}
