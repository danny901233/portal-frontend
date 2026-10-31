/**
 * Tyresoft agent routes — caller recognition.
 *
 * Mirrors GarageHive's /api/agent/garagehive/caller (routes/outbound.ts) in both
 * shape and auth, so the voice agent's diaries/tyresoft.py can call it with a
 * near-identical caller_profile() method and the agent-side machinery doesn't
 * care which integration the garage uses.
 *
 * Data source difference from GH:
 *   GH         live Business Central phonebook over HTTPS
 *   Tyresoft   our own DB table, populated nightly from SFTP CSVs by
 *              jobs/tyresoftCustomerIngest.ts
 *
 * The response shape is deliberately identical so the agent treats both the same.
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { normalisePhone } from '../utils/normalisePhone.js';

const router = Router();

interface TyresoftVehicleOut {
  registration: string;
  make?: string;
  model?: string;
  motDueDate?: string;
  serviceDueDate?: string;
}

interface CallerProfileOut {
  matched: boolean;
  customerNo?: string;
  name?: string;
  vehicles: TyresoftVehicleOut[];
}

const NO_MATCH: CallerProfileOut = { matched: false, vehicles: [] };

function iso(d: Date | null | undefined): string | undefined {
  return d ? d.toISOString().slice(0, 10) : undefined;
}

/**
 * Is this a Tyresoft garage?
 *
 * The flag alone is not enough, and matching the agent here is the whole point. `build_diary`
 * in the agent (diaries/__init__.py) infers the provider from the credentials when the flag
 * still says "none":
 *
 *     elif config.get("tsApiKey") or config.get("tsWorkspace"):
 *         key = "tyresoft"
 *
 * Elite Autocare and Lurgan Tyre Centre are both in exactly that state today — full Tyresoft
 * credentials, `connectedAt` and `goLiveEmailedAt` on Lurgan, and `integrationProvider` still
 * "none" because the config validator rejected the value for months before it was widened.
 * The agent has been running the Tyresoft adapter for them regardless.
 *
 * A strict flag check here would have meant this endpoint answering NO_MATCH for the only two
 * real Tyresoft garages while the agent happily asked it the question — a mismatch nobody
 * would see, because a caller who is not recognised looks exactly like a caller we have never
 * met.
 */
function isTyresoftGarage(cfg: {
  integrationProvider: string | null;
  integrationProviderConfig: unknown;
}): boolean {
  if (cfg.integrationProvider === 'tyresoft') return true;
  if (cfg.integrationProvider && cfg.integrationProvider !== 'none') return false;
  const c = (cfg.integrationProviderConfig ?? {}) as Record<string, unknown>;
  return Boolean(c.tsApiKey || c.tsWorkspace);
}

async function getTyresoftCallerProfile(
  garageId: string,
  rawPhone: string,
): Promise<CallerProfileOut> {
  // Same per-garage toggle as GH. Keeps the agent inert by default; a garage opts in
  // via Agent Setup → Booking & Transfers → Caller Recognition.
  const cfg = await prisma.agentConfiguration.findUnique({
    where: { garageId },
    select: {
      callerRecognitionEnabled: true,
      integrationProvider: true,
      integrationProviderConfig: true,
    },
  });
  if (!cfg?.callerRecognitionEnabled) return NO_MATCH;
  if (!isTyresoftGarage(cfg)) return NO_MATCH;

  const phone = normalisePhone(rawPhone);
  if (!phone) return NO_MATCH;

  // Match on either normalised mobile OR normalised telephone.
  //
  // AMBIGUITY IS A NO-MATCH. In Elite's export 1,709 numbers (6.7% of distinct
  // phones) are shared by two or more accounts — family members, trade accounts,
  // one number against three customer records. Picking one would greet roughly
  // 1 in 15 recognised callers by somebody else's name, which is worse than not
  // recognising them at all: an unrecognised caller just gets today's flow, a
  // misrecognised one gets told they're someone else.
  const candidates = await prisma.tyresoftCustomer.findMany({
    where: { garageId, OR: [{ mobile: phone }, { telephone: phone }] },
    select: { customerAccountNumber: true, name: true },
    take: 2, // only need to know whether it's exactly one
  });
  if (candidates.length !== 1) return NO_MATCH;
  const candidate = candidates[0];

  const vehicles = await prisma.tyresoftVehicle.findMany({
    where: { garageId, customerAccountNumber: candidate.customerAccountNumber },
    select: {
      vrm: true, make: true, model: true,
      motDueDate: true, serviceDueDate: true,
    },
    orderBy: { updatedAt: 'desc' },
  });

  return {
    matched: true,
    customerNo: candidate.customerAccountNumber,
    name: candidate.name || undefined,
    vehicles: vehicles.map((v: any) => ({
      registration: v.vrm,
      make: v.make || undefined,
      model: v.model || undefined,
      motDueDate: iso(v.motDueDate),
      serviceDueDate: iso(v.serviceDueDate),
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/agent/tyresoft/caller?garageId=...&phone=...
// Agent webhook secret auth (not a user JWT).
// ---------------------------------------------------------------------------
router.get('/agent/tyresoft/caller', async (req: Request, res: Response) => {
  const configured = process.env.WEBHOOK_SECRET;
  const provided = req.headers['x-webhook-secret'] ?? req.headers['webhook-secret'];
  if (configured && provided !== configured) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { garageId, phone } = req.query as { garageId: string; phone: string };
    if (!garageId || !phone) {
      return res.status(400).json({ error: 'garageId and phone are required' });
    }
    const profile = await getTyresoftCallerProfile(garageId, phone);
    res.json(profile);
  } catch (error: unknown) {
    console.error('[AGENT] Tyresoft caller lookup error:', error);
    res.status(502).json({ error: 'Failed to look up caller in Tyresoft' });
  }
});

export default router;
