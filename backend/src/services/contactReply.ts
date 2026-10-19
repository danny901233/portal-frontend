/**
 * The surname out of a reply to "what's your surname?", or null.
 *
 * Garage Hive refuses a booking without a surname, so the agent asks for one — and the contact
 * fastpath that drives that part of the conversation parsed phone, email, postcode and house
 * number only. A surname given there was silently dropped and the booking went in under the
 * placeholder "Customer": Katherine Ractliffe at Speedy Spanners, 19 Oct 2026, is "Katherine
 * Customer" in their diary.
 *
 * Narrow on purpose. Everything else arriving at that step — a confirmation, a refusal, a
 * question, a postcode, a house number, a registration — must come back null, because a wrong
 * surname on a real booking is worse than the placeholder.
 */

// "It's Smith", "my surname is Smith", "surname Smith", "last name's Smith".
const LEAD_IN = /^(?:it(?:'|’)?s|it is|i(?:'|’)?m|my\s+)?\s*(?:(?:sur|last|family)\s*name(?:'|’)?s?\s*(?:is\s*)?)?/i;

// A reply that is plainly not a name, however it is spelled.
const NOT_A_SURNAME = new Set([
  'yes', 'yeah', 'yep', 'yup', 'no', 'nope', 'ok', 'okay', 'sure', 'correct', 'right',
  'thanks', 'thank you', 'cheers', 'ta', 'please', 'none', 'n/a', 'na', 'nothing',
  'sorry', 'what', 'why', 'who', 'done', 'fine', 'good', 'great', 'perfect',
]);

const WORD = /^[A-Za-z][A-Za-z'’-]{1,24}$/;

export function surnameFromReply(message: string): string | null {
  const raw = String(message || '').trim();
  if (!raw || raw.includes('@') || raw.includes('?')) return null;
  if (/\d/.test(raw)) return null; // postcodes, house numbers, registrations

  const stripped = raw.replace(LEAD_IN, '').replace(/[.,!]+$/, '').trim();
  if (!stripped) return null;
  if (NOT_A_SURNAME.has(stripped.toLowerCase())) return null;

  // One to three words: "Smith", "Smith-Jones", "Van Der Berg". Anything longer is a sentence,
  // and a sentence at this step is a question or a refusal, not a name.
  const words = stripped.split(/\s+/);
  if (words.length > 3) return null;
  if (!words.every((w) => WORD.test(w) && !NOT_A_SURNAME.has(w.toLowerCase()))) return null;

  return stripped;
}
