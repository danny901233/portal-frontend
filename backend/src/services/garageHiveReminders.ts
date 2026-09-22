// ---------------------------------------------------------------------------
// Daily Garage Hive reminder run. For each garage with an enabled connection:
//   1. pull vehicles due MOT/service in `reminderDaysAhead` days (Garage Hive)
//   2. drop any already reminded for the same reg+type recently (idempotency)
//   3. create an outbound campaign using the garage's approved template
//   4. send it via the shared outbound pipeline (delivery/read/reply tracking
//      then flows automatically through the WhatsApp webhook)
// ---------------------------------------------------------------------------
import { prisma } from '../db.js';
import { resolveCreds, getReminderContacts, parseDueTypes } from './garageHiveBc.js';
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
  /** Staged runs hand every send to the sweep, so nothing goes out from this job. */
  queuedForSweep?: number;
  error?: string;
}

type Connection = Awaited<ReturnType<typeof prisma.garageHiveConnection.findFirst>>;

/** One chase: how many days before the due date, and which template says it. */
export interface ReminderStage {
  days: number;
  templateId: string | null;
}

/** At most this many chases. Four messages about one MOT is not a reminder, it is pestering. */
export const MAX_REMINDER_STAGES = 4;

/**
 * Read a garage's staged schedule, largest-first and cleaned up.
 *
 * Returns [] when nothing is configured, which is the signal to fall back to the original
 * single-send behaviour rather than to send nothing.
 */
export function parseReminderSchedule(value: unknown): ReminderStage[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const stages: ReminderStage[] = [];
  for (const raw of value) {
    const days = Number((raw as { days?: unknown })?.days);
    if (!Number.isFinite(days) || days < 0 || days > 365 || seen.has(days)) continue;
    seen.add(days);
    const templateId = (raw as { templateId?: unknown })?.templateId;
    stages.push({ days, templateId: typeof templateId === 'string' && templateId ? templateId : null });
  }
  // Largest first: the sweep counts DOWN to the due date, so stage order is the send order.
  return stages.sort((a, b) => b.days - a.days).slice(0, MAX_REMINDER_STAGES);
}

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

/** The date this reminder counts down to, as a Date the sweep can compare. */
function dueDateOf(c: { dueType: string; motDueDate?: string; serviceDueDate?: string }): Date | null {
  const raw = c.dueType === 'mot' ? c.motDueDate : c.serviceDueDate;
  if (!raw) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
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

  // A staged schedule pulls at its FIRST stage. That stage is the entry point: a vehicle has to
  // be picked up as it crosses the widest mark, because every later chase counts down the same
  // contact row. Pull at 14 with a 30-day stage configured and the 30 never fires.
  const schedule = parseReminderSchedule(conn.reminderSchedule);
  const daysAhead = schedule.length ? schedule[0].days : (conn.reminderDaysAhead ?? 30);

  // The daily run chases exactly what the garage picked in the portal. Unset means both, which is
  // how every connection behaved before the setting existed.
  const dueTypes = parseDueTypes(conn.reminderDueTypes);
  const { contacts, skipped } = await getReminderContacts(creds, daysAhead, new Date(), dueTypes);
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
      // The sweep counts down from this. Without it a contact is invisible to every later stage,
      // which is one of the reasons these reminders never chased anybody.
      dueDate: dueDateOf(c),
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
  const firstTemplateId = schedule.length ? schedule[0].templateId : conn.reminderTemplateId;
  const variableMapping = firstTemplateId ? await deriveVariableMapping(firstTemplateId) : {};

  const campaign = await prisma.outboundCampaign.create({
    data: {
      garageId,
      name: `Garage Hive reminders — ${dateLabel}`,
      channel: conn.reminderChannel || 'whatsapp',
      totalContacts: contactData.length,
      messageTemplateId: firstTemplateId || undefined,
      variableMapping: Object.keys(variableMapping).length ? variableMapping : undefined,
      // Staged runs are reminders in the sweep's sense; a single-send run stays 'oneoff' so it
      // keeps behaving exactly as it did and is never chased.
      ...(schedule.length && {
        campaignType: 'reminder',
        reminderStages: schedule.map((st) => st.days),
        stageTemplates: Object.fromEntries(
          schedule.filter((st) => st.templateId).map((st) => [String(st.days), st.templateId]),
        ),
      }),
      contacts: { create: contactData },
    },
  });
  base.campaignId = campaign.id;

  // A staged run does not send here. The sweep owns every stage including the first, so there is
  // one send path rather than two that have to agree about what has already gone out — and the
  // sweep runs 15 minutes after this job for exactly that reason. Contacts stay 'pending', which
  // is what keeps them visible to it; stagesSent is the only thing that stops a repeat.
  if (schedule.length) {
    await markRun(conn.id, null);
    return { ...base, ok: true, sent: 0, queuedForSweep: contactData.length };
  }

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
