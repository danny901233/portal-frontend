// Admin "Connect GarageHive" flow. GarageHive gives us the instance; we resolve every branch of
// the business to its own location by matching the garage's name/address to the /init location
// list, then write the config and flip each branch to Automate. Separate router (mirrors
// billing-activation.ts / onboarding-pipeline.ts) to keep admin.ts from growing further.
//
// RECOVERED 2026-09-09 from dist/routes/garagehive-connect.js — the source was never committed,
// so it was lost when the box became a clean checkout and the routes silently stopped being
// mounted. Committed this time.
import { Router, type Request, type Response } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { prisma } from '../db.js';
import {
  resolveSharedGhApiKey,
  ghInit,
  matchBranch,
  verifyConnectToken,
  autoConnectBusiness,
  announceGoLiveIfReady,
} from '../services/garageHiveConnect.js';
import { sendAgentConfigWebhook } from './config.js';
import { sendEmail } from '../utils/email.js';

const router = Router();

/** Prisma JSON columns come back as JsonValue; every read here wants a plain object. */
const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// The agent a GarageHive garage is put on when staff commit a mapping. Kept in step with
// services/garageHiveConnect.ts — new GarageHive garages go on the unified agent.
const GH_AGENT_SCRIPT = 'unified-agent';

// ---- PUBLIC, token-gated (no login) — the link emailed to GarageHive -------
// GET /api/garagehive-connect/validate?token=... -> confirm the link + show who it's for.
router.get('/garagehive-connect/validate', async (req: Request, res: Response) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const businessId = verifyConnectToken(token);
  if (!businessId)
    return res.status(401).json({ ok: false, error: 'This link is invalid or has expired.' });
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true },
  });
  return res.json({ ok: true, businessName: business?.name ?? 'this business' });
});

// POST /api/garagehive-connect/submit { token, instance } -> auto-match every branch & connect.
// GarageHive only supplies the instance; we resolve the branches and wire the diary.
router.post('/garagehive-connect/submit', async (req: Request, res: Response) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const instance = typeof req.body?.instance === 'string' ? req.body.instance.trim() : '';
  const businessId = verifyConnectToken(token);
  if (!businessId)
    return res.status(401).json({ ok: false, error: 'This link is invalid or has expired.' });
  if (!instance)
    return res.status(400).json({ ok: false, error: 'Please enter the GarageHive instance.' });

  const result = await autoConnectBusiness(businessId, instance);
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });

  // Notify us: what connected, and anything we couldn't confidently match (needs a staff pick).
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true },
  });
  const lines = [
    `GarageHive connect submitted for ${business?.name ?? businessId} (instance "${instance}").`,
    '',
    `Connected (${result.connected.length}):`,
    ...result.connected.map((c) => {
      const tb = c.testBooking;
      const tbStr = tb
        ? tb.ok
          ? `\n     ↳ test booking placed (${tb.service} @ ${tb.when}, id ${tb.bookingId}) — please cancel in GarageHive`
          : `\n     ↳ ⚠ test booking FAILED: ${tb.error}`
        : '';
      return `  ✓ ${c.garageName} → location ${c.locationId}${tbStr}`;
    }),
  ];
  if (result.flagged.length) {
    lines.push(
      '',
      `NEEDS A STAFF PICK (${result.flagged.length}) — open Agreements → Connect GarageHive to finish:`,
    );
    lines.push(
      ...result.flagged.map(
        (f) => `  ⚠ ${f.garageName} (best guess ${f.matchedLocationId ?? 'none'}, ${f.confidence})`,
      ),
    );
  }
  const summaryText = lines.join('\n');
  void sendEmail({
    to: ['dan@receptionmate.co.uk'],
    subject: `GarageHive connect — ${business?.name ?? 'garage'}`,
    text: summaryText,
    html: `<pre style="font-family:inherit;white-space:pre-wrap">${summaryText.replace(/</g, '&lt;')}</pre>`,
  });

  return res.json({
    ok: true,
    connectedCount: result.connected.length,
    flaggedCount: result.flagged.length,
    businessName: business?.name ?? 'your garage',
  });
});

// ---- GARAGE LINK ADVANCED (Business Central) — same token, separate form ---
// The connect flow above wires the online-booking diary. Service history, caller recognition and
// MOT reminders come from Business Central, whose credentials only exist once the garage upgrades
// to what GarageHive sell as "Garage Link Advanced". One set of credentials per company, plus a
// location code per branch — that split is why this can't just be another field on the form above.

// GET /api/garagehive-advanced/validate?token=... -> who it's for, and which branches need a code.
router.get('/garagehive-advanced/validate', async (req: Request, res: Response) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const businessId = verifyConnectToken(token);
  if (!businessId)
    return res.status(401).json({ ok: false, error: 'This link is invalid or has expired.' });
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true },
  });
  const branches = await prisma.garage.findMany({
    where: { businessId },
    select: { id: true, name: true, garageHiveConnection: { select: { locationCode: true } } },
    orderBy: { name: 'asc' },
  });
  return res.json({
    ok: true,
    businessName: business?.name ?? 'this business',
    branches: branches.map((b) => ({
      id: b.id,
      name: b.name,
      locationCode: b.garageHiveConnection?.locationCode ?? '',
    })),
  });
});

// POST /api/garagehive-advanced/submit
//   { token, tenantId, environmentName, companyId, clientId?, clientSecret?, locations: {garageId: code} }
router.post('/garagehive-advanced/submit', async (req: Request, res: Response) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const businessId = verifyConnectToken(token);
  if (!businessId)
    return res.status(401).json({ ok: false, error: 'This link is invalid or has expired.' });

  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const tenantId = str(req.body?.tenantId);
  const environmentName = str(req.body?.environmentName) || 'Production';
  const companyId = str(req.body?.companyId);
  const clientId = str(req.body?.clientId);
  const clientSecret = str(req.body?.clientSecret);
  const locations = asObject(req.body?.locations);

  const missing = [
    !tenantId && 'tenant ID',
    !companyId && 'company ID',
  ].filter(Boolean) as string[];
  if (missing.length)
    return res.status(400).json({ ok: false, error: `Please fill in the ${missing.join(' and ')}.` });

  // Only write branches this business actually owns — the token names the business, never a
  // garage, so an id in the body is untrusted input.
  const branches = await prisma.garage.findMany({
    where: { businessId },
    select: { id: true, name: true },
  });
  const owned = new Map(branches.map((b) => [b.id, b.name]));

  const linked: string[] = [];
  const skipped: string[] = [];
  for (const [garageId, raw] of Object.entries(locations)) {
    const locationCode = str(raw);
    const branchName = owned.get(garageId);
    if (!branchName) continue;
    if (!locationCode) {
      skipped.push(branchName);
      continue;
    }
    // clientId/clientSecret are optional: some tenants authorise by a shared app registration
    // held our side. Never blank an existing secret just because this form left it empty.
    await prisma.garageHiveConnection.upsert({
      where: { garageId },
      create: {
        garageId,
        tenantId,
        environmentName,
        companyId,
        locationCode,
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        callerRecognitionEnabled: true,
      },
      update: {
        tenantId,
        environmentName,
        companyId,
        locationCode,
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        callerRecognitionEnabled: true,
      },
    });
    // Caller recognition lives on the agent config too, and the agent reads THAT one.
    await prisma.agentConfiguration
      .update({ where: { garageId }, data: { callerRecognitionEnabled: true } })
      .catch(() => undefined);
    void sendAgentConfigWebhook(garageId);
    linked.push(`${branchName} → ${locationCode}`);
  }

  if (!linked.length)
    return res
      .status(400)
      .json({ ok: false, error: 'Please enter a location code for at least one branch.' });

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true },
  });
  const summary = [
    `Garage Link Advanced connected for ${business?.name ?? businessId}.`,
    '',
    `Tenant ${tenantId} / environment ${environmentName} / company ${companyId}`,
    `API credentials supplied: ${clientId ? 'yes' : 'no'}`,
    '',
    `Linked (${linked.length}):`,
    ...linked.map((l) => `  ✓ ${l}`),
    ...(skipped.length ? ['', `No location code given (${skipped.length}):`, ...skipped.map((s) => `  – ${s}`)] : []),
  ].join('\n');
  void sendEmail({
    to: ['dan@receptionmate.co.uk'],
    subject: `Garage Link Advanced — ${business?.name ?? 'garage'}`,
    text: summary,
    html: `<pre style="font-family:inherit;white-space:pre-wrap">${summary.replace(/</g, '&lt;')}</pre>`,
  });

  return res.json({
    ok: true,
    linkedCount: linked.length,
    skippedCount: skipped.length,
    businessName: business?.name ?? 'your garage',
  });
});

// POST /api/admin/garagehive/preview  { businessId, instance }
// Runs /init and auto-matches every branch of the business. No writes — just the proposed mapping
// for staff to eyeball (and override the low-confidence ones) before committing.
router.post(
  '/admin/garagehive/preview',
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    let businessId = typeof req.body?.businessId === 'string' ? req.body.businessId : '';
    const agreementId = typeof req.body?.agreementId === 'string' ? req.body.agreementId : '';
    const instance = typeof req.body?.instance === 'string' ? req.body.instance.trim() : '';
    // Callers from the agreements screen have an agreementId, not a businessId — resolve it.
    if (!businessId && agreementId) {
      const a = await prisma.agreement.findUnique({
        where: { id: agreementId },
        select: { businessId: true },
      });
      businessId = a?.businessId || '';
    }
    if (!businessId || !instance)
      return res.status(400).json({ error: 'businessId (or agreementId) and instance are required' });
    const apiKey = await resolveSharedGhApiKey();
    if (!apiKey)
      return res.status(500).json({ error: 'No shared GarageHive API key available on the server' });
    const garages = await prisma.garage.findMany({
      where: { businessId },
      select: {
        id: true,
        name: true,
        agentConfiguration: { select: { branchAddress: true, integrationProviderConfig: true } },
      },
      orderBy: { name: 'asc' },
    });
    if (!garages.length) return res.status(404).json({ error: 'No garages found for that business' });
    const init = await ghInit(instance, apiKey);
    if (!init.ok) {
      return res.status(400).json({
        error: `Could not reach GarageHive for instance "${instance}" (${init.error || init.status}). Check the instance name.`,
      });
    }
    const branches = garages.map((g) => {
      const addr = g.agentConfiguration?.branchAddress || '';
      const m = matchBranch(g.name, addr, init.locations);
      const ipc = asObject(g.agentConfiguration?.integrationProviderConfig);
      return {
        garageId: g.id,
        garageName: g.name,
        matchedLocationId: m.locationId,
        confidence: m.confidence, // 'auto' | 'high' | 'low' | 'none'
        score: m.score,
        runnerUpScore: m.runnerUpScore,
        currentLocationId: typeof ipc.locationId === 'string' ? ipc.locationId : null,
      };
    });
    const latestAgreement = await prisma.agreement.findFirst({
      where: { businessId },
      select: { centresCount: true },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({
      instance,
      locations: init.locations, // [{ id, name, address }]
      branches,
      garageCount: garages.length,
      agreementCentresCount: latestAgreement?.centresCount ?? null,
    });
  },
);

// POST /api/admin/garagehive/connect  { instance, mappings: [{ garageId, locationId }] }
// Commits the chosen mapping: writes { customerId, apiKey, locationId } to each branch's config,
// flips it to Automate, and pushes to the agent (DynamoDB) via sendAgentConfigWebhook.
router.post(
  '/admin/garagehive/connect',
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    const instance = typeof req.body?.instance === 'string' ? req.body.instance.trim() : '';
    const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
    if (!instance || !mappings.length)
      return res.status(400).json({ error: 'instance and mappings are required' });
    const apiKey = await resolveSharedGhApiKey();
    if (!apiKey)
      return res.status(500).json({ error: 'No shared GarageHive API key available on the server' });
    const results: Array<{ garageId: string; ok: boolean; locationId?: string; error?: string }> = [];
    for (const m of mappings) {
      const garageId = typeof m?.garageId === 'string' ? m.garageId : '';
      const locationId = m?.locationId != null && m.locationId !== '' ? String(m.locationId) : '';
      if (!garageId || !locationId) {
        results.push({ garageId, ok: false, error: 'missing garageId or locationId' });
        continue;
      }
      try {
        const garage = await prisma.garage.findUnique({
          where: { id: garageId },
          select: {
            name: true,
            agentConfiguration: { select: { integrationProviderConfig: true } },
          },
        });
        if (!garage) {
          results.push({ garageId, ok: false, error: 'garage not found' });
          continue;
        }
        const existingIpc = asObject(garage.agentConfiguration?.integrationProviderConfig);
        const integrationProviderConfig = { ...existingIpc, apiKey, customerId: instance, locationId };
        await prisma.agentConfiguration.upsert({
          where: { garageId },
          update: {
            integrationProvider: 'garage_hive',
            integrationProviderConfig,
            agentType: 'automate',
            agentScript: GH_AGENT_SCRIPT,
          },
          create: {
            garageId,
            branchName: garage.name,
            integrationProvider: 'garage_hive',
            integrationProviderConfig,
            agentType: 'automate',
            agentScript: GH_AGENT_SCRIPT,
          },
        });
        // Push to the runtime config the agent reads (DynamoDB). Best-effort inside the helper.
        await sendAgentConfigWebhook(garageId);
        // Connecting the diary is the second of the two things go-live waits for, and a branch
        // finished HERE is one the matcher was not confident enough to do automatically — so
        // this is the path a flagged garage always takes. Without it, staff complete the
        // connection and the customer is never told, never gets their login, and the deal
        // quietly stalls at the last step.
        await announceGoLiveIfReady(garageId).catch(() => {});
        results.push({ garageId, ok: true, locationId });
      } catch (e) {
        results.push({ garageId, ok: false, error: e instanceof Error ? e.message : 'failed' });
      }
    }
    return res.json({ instance, connected: results.filter((r) => r.ok).length, results });
  },
);

export default router;
