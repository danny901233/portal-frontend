/**
 * What a Bookar garage can take a booking for when the customer's words do not match a service
 * name — and the instruction to say so, handed to the model WITH the catalogue.
 *
 * EAC Telford, 30 days to 20 Oct 2026: 107 chats, 3 bookings, and the garage's phone number given
 * out in 56 of them. The agent told customers it could not book a DPF clean ("yes, we do offer
 * DPF cleaning, but it's best to call us"), a battery replacement and front discs and pads — while
 * the garage's own list carried a free "Engine Issue" triage, a £173.81 "Diagnostic Assessment"
 * and an "Others" catch-all. Nothing was missing but the instinct to use them.
 *
 * The prompt already said "do not invent a service". That is the rule it kept. What it lacked was
 * somewhere to put a job it could not name, so it reached for the telephone — which is the same
 * lesson as the garage rules: an instruction has to arrive where the decision is made, not in a
 * paragraph the model read a thousand tokens earlier.
 */

export interface BookarServiceLike {
  id: number;
  name: string;
  type?: string;
  price_numeric?: number;
}

export interface CatalogueFallback {
  id: number;
  name: string;
}

export interface CatalogueFallbacks {
  /** A free look-at-it slot, e.g. "Engine Issue". Best home for a described symptom. */
  triage?: CatalogueFallback;
  /** A paid investigation, e.g. "Diagnostic Assessment". */
  diagnostic?: CatalogueFallback;
  /** The garage's own catch-all, e.g. "Others" — anything with a name of its own. */
  catchAll?: CatalogueFallback;
}

// "Hybrid Diagnostic Assessment" and "Full EV Diagnostic Assessment" are real entries at EAC, and
// a petrol Mondeo must not be sent to either. The plain one wins; a variant only stands in when
// the garage has nothing else.
const EV_OR_HYBRID = /\b(ev|electric|hybrid|phev)\b/i;

const DIAGNOSTIC = /\bdiagnostic|\bdiagnosis\b/i;
const TRIAGE = /\b(issue|problem|fault|concern|investigat\w*|look at|check over|health check)\b/i;
const CATCH_ALL = /^\s*(others?|other work|miscellaneous|misc|general|something else|not listed)\b/i;

function pick(
  services: BookarServiceLike[],
  match: RegExp,
  prefer: (a: BookarServiceLike, b: BookarServiceLike) => number,
): CatalogueFallback | undefined {
  const hits = services.filter((s) => s && typeof s.name === 'string' && match.test(s.name));
  if (!hits.length) return undefined;
  const best = [...hits].sort(prefer)[0];
  return { id: best.id, name: best.name };
}

/** Plain before EV/hybrid, then cheapest first. */
function plainThenCheapest(a: BookarServiceLike, b: BookarServiceLike): number {
  const aSpecial = EV_OR_HYBRID.test(a.name) ? 1 : 0;
  const bSpecial = EV_OR_HYBRID.test(b.name) ? 1 : 0;
  if (aSpecial !== bSpecial) return aSpecial - bSpecial;
  return (a.price_numeric ?? 0) - (b.price_numeric ?? 0);
}

export function catalogueFallbacks(services: BookarServiceLike[]): CatalogueFallbacks {
  const list = Array.isArray(services) ? services : [];
  const out: CatalogueFallbacks = {};

  const catchAll = pick(list, CATCH_ALL, plainThenCheapest);
  if (catchAll) out.catchAll = catchAll;

  const diagnostic = pick(list, DIAGNOSTIC, plainThenCheapest);
  if (diagnostic) out.diagnostic = diagnostic;

  // A triage slot is the free one. Anything priced is a diagnostic, not a look-at-it, and the
  // catch-all is matched separately — so neither should be claimed here.
  const triage = pick(
    list.filter((s) => !DIAGNOSTIC.test(s.name) && !CATCH_ALL.test(s.name)
      && (s.price_numeric ?? 0) === 0 && String(s.type || '').toUpperCase() !== 'QUOTE'),
    TRIAGE,
    plainThenCheapest,
  );
  if (triage) out.triage = triage;

  return out;
}

/**
 * The line that travels with the catalogue, telling the model where to put a job it cannot name.
 *
 * `canTakeMessage` is the garage's messagingHumanHandoff: with it off there is no tool to pass
 * anything on with, so the phone number becomes the honest last resort — but ONLY once the
 * catalogue has genuinely nothing to book the work as.
 */
export function matchingDirective(services: BookarServiceLike[], canTakeMessage: boolean): string {
  const f = catalogueFallbacks(services);
  const name = (x?: CatalogueFallback) => (x ? `"${x.name}" (id ${x.id})` : '');

  const lastResort = canTakeMessage
    ? 'call bk_take_message with what they asked for'
    : 'say we cannot book that one over chat and give them the garage phone number';

  if (!f.triage && !f.diagnostic && !f.catchAll) {
    return 'MATCHING: this garage\'s list has no diagnostic or catch-all entry, so work that is '
      + `not listed genuinely cannot be booked here — ${lastResort}.`;
  }

  const routes: string[] = [];
  if (f.triage || f.diagnostic) {
    const symptomHome = [name(f.triage), name(f.diagnostic)].filter(Boolean).join(' or ');
    routes.push(`a described symptom or fault ("clunking noise", "ABS light", "won't start", `
      + `"gears sticking") → ${symptomHome}`);
  }
  if (f.catchAll) {
    routes.push(`any other named job the list does not carry ("DPF clean", "battery replacement", `
      + `"discs and pads", "spare key", "towbar") → ${name(f.catchAll)}`);
  }

  return 'MATCHING: if what the customer wants is not in this list by name, do not tell them we '
    + 'cannot book it over chat and do not give out the phone number — this garage takes that work, '
    + `it simply books under a general heading. Use ${routes.join('; ')}. Put their own words in `
    + 'the booking notes so the team knows what the job is. The price on that heading is NOT a '
    + 'quote for their job, so SAY THIS when you offer it, in your own words but with nothing '
    + 'left out: that the slot is booked under <heading>, that the £x covers that booking, and '
    + 'that the team will confirm the cost of the work itself when they see the vehicle. Quoting '
    + 'the heading\'s price as if it were the price of their job is the one thing you must not do. '
    + `Only if none of those fit, ${lastResort}.`;
}
