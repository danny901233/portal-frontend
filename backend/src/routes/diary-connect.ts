// Token-gated diary connection for Bookar, Poole and Tyresoft — the same journey GarageHive
// already has (routes/garagehive-connect.ts), for the providers who supply credentials directly
// rather than an instance we can resolve branches from.
//
// Both endpoints are PUBLIC and gated only by the signed token in the emailed link: the GMS
// provider has no portal login, and asking them to have one is what stops this being used.
import { Router, type Request, type Response } from 'express';
import { prisma } from '../db.js';
import {
  PROVIDERS,
  verifyDiaryToken,
  businessBranches,
  connectBusinessDiary,
} from '../services/diaryConnect.js';
import { announceGoLiveIfReady } from '../services/garageHiveConnect.js';
import { setOnboardingStage } from '../utils/onboardingStage.js';

const router = Router();

const asRecord = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>))
    if (typeof val === 'string') out[k] = val.trim();
  return out;
};

// GET /api/diary-connect/validate?token=... -> who it's for, and the fields to render.
// The field list comes from the SERVER so the form cannot be talked into collecting something
// the adapter does not read.
router.get('/diary-connect/validate', async (req: Request, res: Response) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const claim = verifyDiaryToken(token);
  if (!claim) return res.status(401).json({ ok: false, error: 'This link is invalid or has expired.' });
  const business = await prisma.business.findUnique({
    where: { id: claim.businessId },
    select: { name: true, diaryLinkOpenedAt: true },
  });

  // They have reached the form. Recorded HERE rather than taken from Mailgun: open and click
  // tracking needs the right domain settings, images to load, and no proxy pre-fetching links —
  // whereas this fires when a person actually arrives. First touch only, so a chase email can
  // say "you opened this on the 14th" rather than reporting the most recent refresh.
  if (!business?.diaryLinkOpenedAt) {
    prisma.business
      .update({ where: { id: claim.businessId }, data: { diaryLinkOpenedAt: new Date() } })
      .then(() => console.log(`[DIARY-CONNECT] credentials link opened for ${business?.name ?? claim.businessId}`))
      .catch((e) => console.error('[DIARY-CONNECT] could not record the link opening:', e));
  }
  const branches = await businessBranches(claim.businessId);
  const spec = PROVIDERS[claim.provider];
  return res.json({
    ok: true,
    provider: claim.provider,
    providerLabel: spec.label,
    businessName: business?.name ?? 'this business',
    sharedFields: spec.shared,
    branchFields: spec.perBranch,
    branches: branches.map((b) => ({
      id: b.id,
      name: b.name,
      address: b.agentConfiguration?.branchAddress ?? '',
    })),
  });
});

// POST /api/diary-connect/submit { token, shared:{}, branches:{ [garageId]: {} } }
// Checks the credentials against the provider's own API, then connects every branch.
router.post('/diary-connect/submit', async (req: Request, res: Response) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const claim = verifyDiaryToken(token);
  if (!claim) return res.status(401).json({ ok: false, error: 'This link is invalid or has expired.' });

  const shared = asRecord(req.body?.shared);
  const rawBranches = req.body?.branches;
  const branches: Record<string, Record<string, string>> = {};
  if (rawBranches && typeof rawBranches === 'object' && !Array.isArray(rawBranches))
    for (const [gid, vals] of Object.entries(rawBranches as Record<string, unknown>))
      branches[gid] = asRecord(vals);

  // Only branches of THIS business, whatever the body claims.
  const allowed = new Set((await businessBranches(claim.businessId)).map((b) => b.id));
  for (const gid of Object.keys(branches)) if (!allowed.has(gid)) delete branches[gid];

  const result = await connectBusinessDiary(claim.businessId, claim.provider, shared, branches);
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });

  // Connected is one of the two go-live tracks; the other is the signed agreement. Whichever
  // finishes last converges here, exactly as the GarageHive flow does.
  for (const b of result.connected) {
    await setOnboardingStage(b.garageId, 'agent_built', { reason: 'diary connected' }).catch(() => {});
    await announceGoLiveIfReady(b.garageId).catch(() => {});
  }
  return res.json({
    ok: true,
    provider: result.provider,
    providerLabel: PROVIDERS[result.provider].label,
    connected: result.connected,
  });
});

export default router;
