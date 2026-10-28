/**
 * The contractual wording, written once, used by both renderers.
 *
 * There are two renderings of one agreement: agreementTemplate.ts produces the HTML the customer
 * reads and signs on screen (captured into Agreement.templateSnapshot), and agreementPdf.ts
 * produces the PDF emailed as their signed copy — the only version they keep. Each used to carry
 * its own copy of the terms.
 *
 * They diverged for sixteen weeks. On 9 July 2026 the HTML moved to a three-month Proof Period
 * plus a twelve-month Contract Term with no termination for convenience; the PDF kept saying
 * "rolling monthly term" with thirty days' notice and had no free-period clauses at all. Thirteen
 * garages signed one contract on screen and were emailed a materially different one. It surfaced
 * on 28 Oct 2026 when Mallory Performance gave notice: the database said they owed the remainder
 * of a committed term, and the PDF in their hand said thirty days.
 *
 * Nothing in the code could have caught it, because nothing connected the two. This module is
 * that connection. Clause 3 and clause 13 are the ones that carry the commitment and the exit, so
 * they live here; if either renderer needs different words, change them here and both move.
 */

export interface FreePeriod {
  freeTrialDays?: number | null;
  freeUntilBookings?: number | null;
}

export interface FreePeriodShape {
  /** Is any free period sold at all? */
  has: boolean;
  /** What the clauses call it: "free trial" or "free period". */
  name: string;
  /** How clause 3.1 introduces it, in plain text. */
  description: string;
}

export const freePeriodShape = (input: FreePeriod): FreePeriodShape => {
  const trialDays =
    input.freeTrialDays && input.freeTrialDays > 0 ? input.freeTrialDays : null;
  const freeBookings =
    input.freeUntilBookings && input.freeUntilBookings > 0 ? input.freeUntilBookings : null;
  return {
    has: Boolean(trialDays || freeBookings),
    name: trialDays ? 'free trial' : 'free period',
    description: trialDays
      ? `a ${trialDays}-day free trial`
      : `a free period lasting until the Client has taken ${freeBookings} confirmed bookings `
        + 'through the Services',
  };
};

/** 3.1 — what the agreement is made of and how long it runs. */
export const clause31 = (free: FreePeriodShape, goLiveSuffix = ''): string =>
  `This Agreement shall commence on the agreed "Go Live" date${goLiveSuffix} and shall comprise: `
  + (free.has
    ? `(a) ${free.description}; (b) an initial fixed term of three (3) months (the "Proof Period") `
      + `commencing at the end of the ${free.name}; and (c)`
    : '(a) an initial fixed term of three (3) months (the "Proof Period"); and (b)')
  + ' upon expiry of the Proof Period, a minimum term of twelve (12) months (the "Contract Term") '
  + 'into which this Agreement shall automatically continue.';

/** 3.2 — what the Client is committed to. */
export const clause32 = (free: FreePeriodShape): string =>
  free.has
    ? `During the ${free.name} the Client may cancel at any time at no cost and shall not be `
      + `charged. After the ${free.name} the Client is committed to the Proof Period and the `
      + 'subsequent Contract Term and may terminate only in accordance with Clause 13.'
    : 'The Client is committed to the Proof Period and the subsequent Contract Term and may '
      + 'terminate only in accordance with Clause 13.';

/** 3.3 — renewal, and the notice that prevents it. */
export const clause33 = (): string =>
  'At the end of the Contract Term, and at the end of each subsequent term, this Agreement shall '
  + 'renew automatically for a further fixed term of twelve (12) months unless either Party gives '
  + "not less than thirty (30) days' written notice before the end of the then-current term.";

/** 13.1 — no exit for convenience, and what is owed if they go anyway. */
export const clause131 = (free: FreePeriodShape): string =>
  (free.has
    ? `The Client may cancel at any time during the ${free.name} at no cost. Thereafter the Client `
      + 'is committed'
    : 'The Client is committed')
  + ' to the Proof Period and the Contract Term and may not terminate for convenience during those '
  + 'periods. Should the Client cease to use the Services, or seek to exit, before the end of the '
  + 'then-current committed term other than for cause, the remaining Licence Fees for that term '
  + 'shall remain payable.';

/** 13.2 — the exit that does exist, once the committed term is served. */
export const clause132 = (): string =>
  'Following the Contract Term, and during any subsequent renewal term, either Party may terminate '
  + "on not less than thirty (30) days' written notice given before the end of the then-current "
  + 'term, in accordance with Clause 3.3.';

/** 13.3 — breach and insolvency. */
export const clause133 = (): string =>
  'Either Party may terminate immediately if the other Party commits a material breach that '
  + "remains unremedied after 10 days of written notice, or upon the other Party's insolvency.";
