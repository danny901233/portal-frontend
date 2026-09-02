/**
 * Which service is due next, given what the vehicle had last.
 *
 * Routine servicing alternates — full then interim, Mercedes A then B, Audi oil service then
 * inspection — so the rule is simply "the other one of the pair". What differs between garages is
 * the naming, which is why the pairs are configuration.
 *
 * Returns null far more often than not, on purpose. A garage with nothing configured, a line that
 * matches no pair, an ambiguous line matching both sides: all silent. Suggesting the wrong service
 * for someone's own car is worse than suggesting nothing, and the suggestion is only ever a
 * prompt for the team to confirm.
 */

export interface ServicePair {
  aMatch: string;   // case-insensitive regex against the invoice line description
  aLabel: string;   // how to say it: "full service"
  bMatch: string;
  bLabel: string;
}

/** Sensible starting point for a UK garage. Still per-garage config; this is only a default. */
export const DEFAULT_SERVICE_PAIRS: ServicePair[] = [
  { aMatch: '\\bfull\\s+service\\b|\\bmajor\\s+service\\b', aLabel: 'full service',
    bMatch: '\\binterim\\s+service\\b|\\bminor\\s+service\\b', bLabel: 'interim service' },
  { aMatch: '"?\\bA\\b"?\\s+service', aLabel: 'A service',
    bMatch: '"?\\bB\\b"?\\s+service', bLabel: 'B service' },
  { aMatch: '\\boil\\s+service\\b', aLabel: 'oil service',
    bMatch: '\\binspection\\s+service\\b', bLabel: 'inspection service' },
];

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;   // a garage typo in config must never throw during a live conversation
  }
}

/**
 * @param lastServiceLine the invoice line describing what they had, verbatim from Garage Hive
 * @param pairs          the garage's configured pairs
 * @returns what to suggest next, and what they had, or null when we cannot say
 */
export function nextServiceAfter(
  lastServiceLine: string | null | undefined,
  pairs: ServicePair[] | null | undefined,
): { had: string; suggest: string } | null {
  const line = String(lastServiceLine || '').trim();
  if (!line || !Array.isArray(pairs) || pairs.length === 0) return null;

  const matches: Array<{ had: string; suggest: string }> = [];
  for (const p of pairs) {
    if (!p || typeof p !== 'object') continue;
    const a = safeRegex(String(p.aMatch || ''));
    const b = safeRegex(String(p.bMatch || ''));
    const hitA = a ? a.test(line) : false;
    const hitB = b ? b.test(line) : false;
    // A line naming BOTH sides tells us nothing about which one they had.
    if (hitA && hitB) return null;
    if (hitA) matches.push({ had: String(p.aLabel || ''), suggest: String(p.bLabel || '') });
    else if (hitB) matches.push({ had: String(p.bLabel || ''), suggest: String(p.aLabel || '') });
  }

  // Two different pairs matching means the naming is ambiguous — say nothing.
  if (matches.length !== 1) return null;
  const only = matches[0];
  return only.had && only.suggest ? only : null;
}
