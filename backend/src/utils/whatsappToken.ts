/**
 * Which credential to use for a garage's WhatsApp calls.
 *
 * Embedded Signup's code exchange hands back a business-integration system-user token that Meta
 * issues with a SIXTY DAY expiry, and we stored it as the garage's credential. Every portal
 * onboard therefore carried a fuse lit on the day they signed up — measured 2026-09-22, all three
 * Garage Hive garages were exactly 60 days from their issue date, with Great Hollands due to go
 * dark on 2026-10-11. Nothing refreshed it and nothing warned; the first sign would have been a
 * garage noticing their agent had stopped replying.
 *
 * Our own system user is an admin on the business, so its token has no expiry AND reaches every
 * WABA a customer shares with us during signup — verified against all nine connected numbers. It
 * is the better credential in both respects, so it goes first.
 *
 * The garage's stored token stays as the fallback, for a WABA that sits outside our business
 * (Elite Landrover's was under a third party's portfolio) and for the case where the shared token
 * is missing or revoked. Preferring the shared one trades nine silent staggered failures for one
 * loud shared failure, which is the right way round — and the watchdog covers that one.
 */
export function whatsappToken(storedToken?: string | null): string {
  const shared = (process.env.META_SYSTEM_USER_TOKEN || '').trim();
  return shared || (storedToken || '').trim();
}

/**
 * Both candidates, best first, de-duplicated — for callers that can retry on a permissions error
 * rather than give up on the first one.
 */
export function whatsappTokens(storedToken?: string | null): string[] {
  const shared = (process.env.META_SYSTEM_USER_TOKEN || '').trim();
  const stored = (storedToken || '').trim();
  return [...new Set([shared, stored].filter(Boolean))];
}
