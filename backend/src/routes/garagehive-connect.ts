// Admin "Connect GarageHive" flow. GarageHive gives us the instance; we resolve every branch of
// the business to its own location by matching the garage's name/address to the /init location
// list, then write the config and flip each branch to Automate. Separate router (mirrors
// billing-activation.ts / onboarding-pipeline.ts) to keep admin.ts from growing further.
import { Router, Request, Response } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { resolveSharedGhApiKey, ghInit, matchBranch } from '../services/garageHiveConnect.js';
import { sendAgentConfigWebhook } from './config.js';

const router = Router();

// POST /api/admin/garagehive/preview  { businessId, instance }
// Runs /init and auto-matches every branch of the business. No writes — just the proposed mapping
// for staff to eyeball (and override the low-confidence ones) before committing.
router.post('/admin/garagehive/preview', authenticate, requireAdmin, async (req: Request, res: Response) => {
  let businessId = typeof req.body?.businessId === 'string' ? req.body.businessId : '';
  const agreementId = typeof req.body?.agreementId === 'string' ? req.body.agreementId : '';
  const instance = typeof req.body?.instance === 'string' ? req.body.instance.trim() : '';
  // Callers from the agreements screen have an agreementId, not a businessId — resolve it.
  if (!businessId && agreementId) {
    const a = await prisma.agreement.findUnique({ where: { id: agreementId }, select: { businessId: true } });
    businessId = a?.businessId || '';
  }
  if (!businessId || !instance) return res.status(400).json({ error: 'businessId (or agreementId) and instance are required' });

  const apiKey = await resolveSharedGhApiKey();
  if (!apiKey) return res.status(500).json({ error: 'No shared GarageHive API key available on the server' });

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
    return res.status(400).json({ error: `Could not reach GarageHive for instance "${instance}" (${init.error || init.status}). Check the instance name.` });
  }

  const branches = garages.map((g) => {
    const addr = g.agentConfiguration?.branchAddress || '';
    const m = matchBranch(g.name, addr, init.locations);
    const ipc = (g.agentConfiguration?.integrationProviderConfig && typeof g.agentConfiguration.integrationProviderConfig === 'object')
      ? (g.agentConfiguration.integrationProviderConfig as Record<string, unknown>)
      : {};
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
});

// POST /api/admin/garagehive/connect  { instance, mappings: [{ garageId, locationId }] }
// Commits the chosen mapping: writes { customerId, apiKey, locationId } to each branch's config,
// flips it to Automate, and pushes to the agent (DynamoDB) via sendAgentConfigWebhook.
router.post('/admin/garagehive/connect', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const instance = typeof req.body?.instance === 'string' ? req.body.instance.trim() : '';
  const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
  if (!instance || !mappings.length) return res.status(400).json({ error: 'instance and mappings are required' });

  const apiKey = await resolveSharedGhApiKey();
  if (!apiKey) return res.status(500).json({ error: 'No shared GarageHive API key available on the server' });

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
        select: { name: true, agentConfiguration: { select: { integrationProviderConfig: true } } },
      });
      if (!garage) {
        results.push({ garageId, ok: false, error: 'garage not found' });
        continue;
      }
      const existingIpc = (garage.agentConfiguration?.integrationProviderConfig && typeof garage.agentConfiguration.integrationProviderConfig === 'object')
        ? (garage.agentConfiguration.integrationProviderConfig as Record<string, unknown>)
        : {};
      const integrationProviderConfig = { ...existingIpc, apiKey, customerId: instance, locationId };

      await prisma.agentConfiguration.upsert({
        where: { garageId },
        update: {
          integrationProvider: 'garage_hive',
          integrationProviderConfig,
          agentType: 'automate',
          agentScript: 'receptionmate-agent-v3',
        },
        create: {
          garageId,
          branchName: garage.name,
          integrationProvider: 'garage_hive',
          integrationProviderConfig,
          agentType: 'automate',
          agentScript: 'receptionmate-agent-v3',
        },
      });

      // Push to the runtime config the agent reads (DynamoDB). Best-effort inside the helper.
      await sendAgentConfigWebhook(garageId);
      results.push({ garageId, ok: true, locationId });
    } catch (e) {
      results.push({ garageId, ok: false, error: e instanceof Error ? e.message : 'failed' });
    }
  }

  return res.json({ instance, connected: results.filter((r) => r.ok).length, results });
});

export default router;
