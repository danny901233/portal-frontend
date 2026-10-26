/**
 * Google Ads offline-conversion feed for ReceptionMate leads.
 *
 * Why this exists: the ONLY conversion fire in the portal is TrialCardForm (the card step).
 * An ad-driven garage that enquires but has not yet reached that step is invisible to Google,
 * so Assist – Search – AI Receptionist UK bid for weeks with NO conversion signal at all while
 * actually producing ~1 qualified enquiry a week (18 with a gclid in 90 days, 0 reported).
 *
 * Mirrors the MMH feed (mmh-api docs_service.py): a key-gated CSV that Google Ads pulls on a
 * schedule. Server-side, so it survives ad-blockers and cross-device journeys, and it can
 * backfill enquiries already taken.
 */
import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';

const router = Router();

const FEED_KEY = (process.env.RM_ADS_FEED_KEY || '').trim();
// Google rejects a click older than 90 days; stay inside with a margin.
const LOOKBACK_DAYS = Number(process.env.RM_ADS_LOOKBACK_DAYS || 85);
const CONVERSION_NAME = (process.env.RM_ADS_CONVERSION_NAME || 'RM Lead (offline import)').trim();
const LEAD_VALUE = Number(process.env.RM_ADS_LEAD_VALUE || 30);

// Statuses that count as a real lead. 'enquiry' = gave name + email. 'prospect' = clicked
// Get started and named their business via the Places lookup, which Dan counts as a lead too.
// Later statuses (pending/completed/signed) are past the card step, where the on-page
// conversion already fires — uploading them too would double-count.
const LEAD_STATUSES = ['enquiry', 'prospect'];

// Test records must never be uploaded: teaching Google to chase traffic that converted
// because WE clicked it is worse than sending no signal at all.
const TEST_EMAIL_PATTERNS = [/@receptionmate\.co\.uk$/i, /@test\./i, /@example\./i, /@mc\.com$/i, /@bbc\.co\.uk$/i];
const TEST_NAME_PATTERNS = [/^tets?$/i, /test/i, /^dan$/i, /^demo$/i, /^asdf/i, /^x+$/i];

function isTest(businessName: string | null, email: string | null): boolean {
  const n = (businessName || '').trim();
  const e = (email || '').trim();
  if (TEST_EMAIL_PATTERNS.some((re) => re.test(e))) return true;
  if (TEST_NAME_PATTERNS.some((re) => re.test(n))) return true;
  return false;
}

/** '2026-10-26T15:15:47Z' -> '2026-10-26 15:15:47+0000' (the format Google wants). */
function convTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+0000');
}

router.get('/ads/rm-lead-conversions.csv', async (req: Request, res: Response) => {
  if (!FEED_KEY) return res.status(503).json({ error: 'Lead conversion feed not configured' });
  if ((req.query.key as string | undefined) !== FEED_KEY) return res.status(403).json({ error: 'Forbidden' });

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000);
  const rows = await prisma.pendingSignup.findMany({
    where: { gclid: { not: null }, createdAt: { gte: cutoff }, status: { in: LEAD_STATUSES } },
    select: { gclid: true, createdAt: true, businessName: true, email: true, status: true },
    orderBy: { createdAt: 'asc' },
  });

  const out = ['Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency'];
  let skippedTest = 0, skippedNoName = 0, skippedBadGclid = 0, skippedDupe = 0;
  // ONE conversion per click. Two PendingSignup rows can share a gclid — the same visitor
  // submitting twice seconds apart (J&J Automotive/JJ Autos, 23s; Adam, 96s). Google dedupes
  // on click id + action + TIME, so differing timestamps would upload as two separate leads
  // and double-count a single click. Keep the earliest row per gclid.
  const seen = new Set<string>();
  for (const r of rows) {
    const gclid = (r.gclid || '').replace(/[",]/g, '').trim();
    // A real Google click id is a long opaque token (Cj0KCQ…, CjwKCAjw…, EAIaIQobChMI…).
    // Hand-typed junk like "test123" reached the DB and would be rejected on import.
    if (!/^[A-Za-z0-9_-]{20,}$/.test(gclid)) { skippedBadGclid++; continue; }
    // A prospect with no business name never got as far as naming themselves — not a lead.
    if (!(r.businessName || '').trim()) { skippedNoName++; continue; }
    if (isTest(r.businessName, r.email)) { skippedTest++; continue; }
    if (seen.has(gclid)) { skippedDupe++; continue; }
    seen.add(gclid);
    out.push(`${gclid},${CONVERSION_NAME},${convTime(r.createdAt)},${LEAD_VALUE.toFixed(2)},GBP`);
  }
  console.log(`[ads-leads] ${out.length - 1} rows served; skipped ${skippedTest} test, `
            + `${skippedNoName} unnamed, ${skippedBadGclid} malformed gclid, ${skippedDupe} duplicate click`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(out.join('\n') + '\n');
});

router.get('/ads/rm-lead-conversions/health', async (req: Request, res: Response) => {
  if (!FEED_KEY || (req.query.key as string | undefined) !== FEED_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000);
  const all = await prisma.pendingSignup.count({ where: { createdAt: { gte: cutoff } } });
  const withGclid = await prisma.pendingSignup.count({
    where: { gclid: { not: null }, createdAt: { gte: cutoff }, status: { in: LEAD_STATUSES } },
  });
  res.json({ ok: true, windowDays: LOOKBACK_DAYS, signupsInWindow: all, leadsWithGclid: withGclid,
             conversionName: CONVERSION_NAME, leadValue: LEAD_VALUE, statuses: LEAD_STATUSES });
});

export default router;
