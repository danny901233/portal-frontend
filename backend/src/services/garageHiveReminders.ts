// ---------------------------------------------------------------------------
// Daily Garage Hive reminder run. For each garage with an enabled connection:
//   1. pull vehicles due MOT/service in `reminderDaysAhead` days (Garage Hive)
//   2. drop any already reminded for the same reg+type recently (idempotency)
//   3. create an outbound campaign using the garage's approved template
//   4. send it via the shared outbound pipeline (delivery/read/reply tracking
//      then flows automatically through the WhatsApp webhook)
// ---------------------------------------------------------------------------
import { prisma } from '../db.js';
import { resolveCreds, getReminderContacts } from './garageHiveBc.js';
import { normalisePhone, sendCampaignById } from './outboundSend.js';

export interface ReminderRunResult {
  garageId: string;
  ok: boolean;
  pulled: number;
  fresh: number;
  skippedDuplicates: number;
  skippedNoContact: number;
  campaignId?: string;
  sent?: number;
  error?: string;
}

type Connection = Awaited<ReturnType<typeof prisma.garageHiveConnection.findFirst>>;

/**
 * Derive the template variable → contact-field mapping the same way the manual
 * UI does: from the template's saved `variableSamples` field assignments.
 */
async function deriveVariableMapping(templateId: string): Promise<Record<string, string>> {
  const tmpl = await prisma.messageTemplate.findUnique({ where: { id: templateId } });
  if (!tmpl) return {};
  const varNums = [...new Set([...tmpl.bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]))];
  const samples = (tmpl.variableSamples as Record<string, string> | null) || {};
  const mapping: Record<string, string> = {};
  for (const n of varNums) {
    const field = samples[`{{${n}}}_field`];
    if (field) mapping[n] = field;
  }
  return mapping;
}

/** Run the reminder flow for a single garage connection. */
export async function runGarageReminders(conn: NonNullable<Connection>): Promise<ReminderRunResult> {
  const garageId = conn.garageId;
  const base: ReminderRunResult = {
    garageId,
    ok: false,
    pulled: 0,
    fresh: 0,
    skippedDuplicates: 0,
    skippedNoContact: 0,
  };

  const creds = await resolveCreds(garageId);
  if (!creds) return { ...base, error: 'No Garage Hive credentials resolved' };

  const daysAhead = conn.reminderDaysAhead ?? 30;
  const { contacts, skipped } = await getReminderContacts(creds, daysAhead);
  base.pulled = contacts.length;
  base.skippedNoContact = skipped.length;

  if (contacts.length === 0) {
    await markRun(conn.id, null);
    return { ...base, ok: true };
  }

  // Idempotency: skip a reg+type already reminded within the recent window so
  // re-runs / retries don't double-message. Window covers the due horizon + slack.
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - (daysAhead + 7));
  const recent = await prisma.outboundContact.findMany({
    where: {
      garageId,
      createdAt: { gte: windowStart },
      status: { in: ['sent', 'delivered', 'read', 'replied'] },
    },
    select: { registration: true, messageType: true },
  });
  const seen = new Set(recent.map((r) => `${(r.registration || '').toUpperCase()}|${r.messageType}`));

  const contactData = contacts
    .filter((c) => !seen.has(`${c.registration.toUpperCase()}|${c.dueType}`))
    .map((c) => ({
      garageId,
      customerName: c.customerName,
      phone: normalisePhone(c.phone),
      registration: c.registration,
      motDueDate: c.motDueDate || null,
      serviceDueDate: c.serviceDueDate || null,
      messageType: c.dueType,
      status: 'pending',
    }));

  base.skippedDuplicates = contacts.length - contactData.length;
  base.fresh = contactData.length;

  if (contactData.length === 0) {
    await markRun(conn.id, null);
    return { ...base, ok: true };
  }

  const dateLabel = new Date().toISOString().slice(0, 10);
  const variableMapping = conn.reminderTemplateId
    ? await deriveVariableMapping(conn.reminderTemplateId)
    : {};

  const campaign = await prisma.outboundCampaign.create({
    data: {
      garageId,
      name: `Garage Hive reminders — ${dateLabel}`,
      channel: conn.reminderChannel || 'whatsapp',
      totalContacts: contactData.length,
      messageTemplateId: conn.reminderTemplateId || undefined,
      variableMapping: Object.keys(variableMapping).length ? variableMapping : undefined,
      contacts: { create: contactData },
    },
  });
  base.campaignId = campaign.id;

  const result = await sendCampaignById(campaign.id);
  if (!result.ok) {
    await markRun(conn.id, result.error || 'Send failed');
    return { ...base, error: result.error };
  }

  await markRun(conn.id, null);
  return { ...base, ok: true, sent: result.sent };
}

async function markRun(connId: string, error: string | null): Promise<void> {
  await prisma.garageHiveConnection.update({
    where: { id: connId },
    data: { lastRunAt: new Date(), lastRunError: error },
  });
}

/** Run reminders for every garage with reminders enabled. */
export async function runDailyGarageHiveReminders(): Promise<ReminderRunResult[]> {
  const conns = await prisma.garageHiveConnection.findMany({ where: { remindersEnabled: true } });
  console.log(`[GH-REMINDERS] Running daily reminders for ${conns.length} garage(s)`);
  const results: ReminderRunResult[] = [];
  for (const conn of conns) {
    try {
      const r = await runGarageReminders(conn);
      results.push(r);
      console.log(
        `[GH-REMINDERS] ${conn.garageId}: pulled=${r.pulled} fresh=${r.fresh} sent=${r.sent ?? 0}` +
          (r.error ? ` error=${r.error}` : ''),
      );
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[GH-REMINDERS] ${conn.garageId} failed:`, e);
      await markRun(conn.id, error).catch(() => {});
      results.push({
        garageId: conn.garageId,
        ok: false,
        pulled: 0,
        fresh: 0,
        skippedDuplicates: 0,
        skippedNoContact: 0,
        error,
      });
    }
  }
  return results;
}
