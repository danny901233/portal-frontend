/**
 * Staged MOT / service reminders.
 *
 * A garage uploads whoever their DMS can export — the full book, or a window — and this sends
 * each customer at THEIR own point before the due date, rather than messaging everyone the
 * moment the file lands. That is the difference between a reminder and a bulk send, and bulk
 * sending is what got a WABA permanently disabled in July.
 *
 * Stages are days-before-due: 30, then 14, then 3 if they still haven't booked. We cannot see
 * bookings made by phone or in person, so the template asks them to tell us; a reply moves them
 * to "booked"/"replied" and the remaining stages are skipped.
 *
 * OFF BY DEFAULT. Set REMINDER_SCHEDULER=on to arm it. Until then it logs what it would send and
 * sends nothing, so it can be watched for a few days against real data before it messages a
 * customer.
 */
import axios from 'axios';
import cron from 'node-cron';
import { prisma } from '../db.js';
import { normalisePhone } from './outboundSend.js';
import { daysUntil } from '../utils/dueDate.js';

/** Used when a reminder campaign somehow has no stages recorded. */
const DEFAULT_STAGES = [30, 14, 3];
/** Never send two reminders to the same person closer together than this. */
const MIN_GAP_DAYS = 7;
/** Fallback WhatsApp 24h send cap when a garage has no campaign tier recorded. */
const DEFAULT_TIER_LIMIT = 250;

export function schedulerArmed(): boolean {
  return String(process.env.REMINDER_SCHEDULER || '').toLowerCase() === 'on';
}

/**
 * Which stage is due for this contact, or null.
 * Picks the LARGEST unsent stage the customer is already inside, so someone uploaded late (say
 * 20 days out) still gets a first reminder rather than silently missing the 30-day mark.
 *
 * `stages` comes from the campaign, so a garage running a single 14-day nudge gets exactly one
 * message, and a one-off offer campaign never reaches here at all.
 */
export function stageDueFor(days: number, stagesSent: number[], stages: number[] = DEFAULT_STAGES): number | null {
  if (days < 0) return null;
  const ordered = [...stages].sort((a, b) => b - a); // largest first
  for (const s of ordered) {
    if (days <= s && !stagesSent.includes(s)) return s;
  }
  return null;
}

type Candidate = {
  id: string; customerName: string; phone: string; registration: string | null;
  motDueDate: string | null; serviceDueDate: string | null; messageType: string;
  dueDate: Date | null; stagesSent: number[]; updatedAt: Date;
  campaign: { id: string; campaignType: string; reminderStages: number[] } | null;
};

export async function runReminderSweep(): Promise<{ garages: number; sent: number; wouldSend: number; expired: number }> {
  const armed = schedulerArmed();
  let sent = 0, wouldSend = 0, expired = 0, garagesTouched = 0;

  const garages = await prisma.garage.findMany({
    where: { hasMessagingAccess: true, accessRestricted: false },
    select: { id: true, name: true },
  });

  for (const garage of garages) {
    const contacts = (await prisma.outboundContact.findMany({
      // campaignType 'reminder' ONLY. A one-off offer or announcement must never be chased —
      // that is a promotion, not a reminder, and repeating it is how a WhatsApp number gets
      // reported. Campaigns created before this field existed default to 'oneoff', so nothing
      // historic is retro-actively turned into a reminder series.
      where: {
        garageId: garage.id, status: 'pending', dueDate: { not: null },
        campaign: { campaignType: 'reminder' },
      },
      select: {
        id: true, customerName: true, phone: true, registration: true, motDueDate: true,
        serviceDueDate: true, messageType: true, dueDate: true, stagesSent: true, updatedAt: true,
        campaign: { select: { id: true, campaignType: true, reminderStages: true } },
      },
      orderBy: { dueDate: 'asc' },
    })) as unknown as Candidate[];
    if (contacts.length === 0) continue;

    // Overdue: never send "your MOT is due on the 3rd" on the 20th.
    const overdue = contacts.filter((c) => c.dueDate && daysUntil(c.dueDate) < 0);
    if (overdue.length) {
      expired += overdue.length;
      if (armed) {
        await prisma.outboundContact.updateMany({
          where: { id: { in: overdue.map((c) => c.id) } },
          data: { status: 'expired' },
        });
      }
    }

    const now = Date.now();
    const due = contacts
      .filter((c) => c.dueDate && daysUntil(c.dueDate) >= 0)
      .map((c) => ({
        c,
        stage: stageDueFor(
          daysUntil(c.dueDate as Date),
          c.stagesSent || [],
          c.campaign?.reminderStages?.length ? c.campaign.reminderStages : DEFAULT_STAGES,
        ),
      }))
      .filter((x): x is { c: Candidate; stage: number } => x.stage !== null)
      // Respect the minimum gap using the last time we touched the row.
      .filter((x) => (x.c.stagesSent?.length ?? 0) === 0
        || now - new Date(x.c.updatedAt).getTime() >= MIN_GAP_DAYS * 86_400_000);
    if (due.length === 0) continue;

    garagesTouched++;

    // An approved template is required — Meta rejects template sends otherwise, and this is a
    // business-initiated message so it cannot be free-form.
    const template = await prisma.messageTemplate.findFirst({
      where: { garageId: garage.id, status: 'approved', name: { in: ['mot_reminder', 'service_reminder'] } },
      select: { name: true, language: true },
    });
    const wa = await prisma.socialMediaConnection.findFirst({
      where: { garageId: garage.id, platform: 'whatsapp', isActive: true },
      select: { whatsappPhoneNumberId: true, accessToken: true },
    });

    if (!template || !wa?.whatsappPhoneNumberId || wa.whatsappPhoneNumberId === 'pending_setup') {
      console.log(`[REMINDERS] ${garage.name}: ${due.length} due but ${!template ? 'no approved template' : 'no WhatsApp connection'} — skipping`);
      continue;
    }

    // 24h cap, counted from what has actually gone out.
    const since = new Date(now - 24 * 60 * 60 * 1000);
    const sentLast24h = await prisma.outboundContact.count({
      where: { garageId: garage.id, status: 'sent', updatedAt: { gte: since } },
    });
    const quota = Math.max(0, DEFAULT_TIER_LIMIT - sentLast24h);
    const batch = due.slice(0, quota);
    if (batch.length < due.length) {
      console.log(`[REMINDERS] ${garage.name}: capping at ${batch.length}/${due.length} (${sentLast24h} already sent in 24h)`);
    }

    for (const { c, stage } of batch) {
      if (!armed) {
        wouldSend++;
        console.log(`[REMINDERS][DRY] ${garage.name}: would send ${stage}-day ${c.messageType} to ${c.phone} (due ${c.dueDate?.toISOString().slice(0, 10)})`);
        continue;
      }
      try {
        const firstName = c.customerName?.trim().split(/\s+/)[0] || c.customerName;
        const dueStr = c.motDueDate || c.serviceDueDate || '';
        // Variable order matches the seeded templates exactly:
        // 1 customer, 2 agent, 3 branch, 4 registration, 5 due date.
        const parameters = [firstName, 'Leah', garage.name, (c.registration || '').toUpperCase(), dueStr]
          .map((text) => ({ type: 'text', text: text || '' }));
        const res = await axios.post(
          `https://graph.facebook.com/v18.0/${wa.whatsappPhoneNumberId}/messages`,
          {
            messaging_product: 'whatsapp',
            to: normalisePhone(c.phone),
            type: 'template',
            template: {
              name: template.name,
              language: { code: template.language || 'en_GB' },
              components: [{ type: 'body', parameters }],
            },
          },
          { headers: { Authorization: `Bearer ${wa.accessToken}` } },
        );
        await prisma.outboundContact.update({
          where: { id: c.id },
          data: {
            stagesSent: { set: [...(c.stagesSent || []), stage] },
            messageSid: res.data?.messages?.[0]?.id || null,
            // Stay 'pending' so later stages can still fire; stagesSent is what stops repeats.
          },
        });
        sent++;
        // Same drip as campaign sends — see outboundSend.ts. A reminder sweep is business-
        // initiated template traffic and looks exactly like a bulk run if it goes out at once.
        await new Promise((r) => setTimeout(r, 3_000 + Math.floor(Math.random() * 2_000)));
      } catch (err: any) {
        const code = err?.response?.data?.error?.code;
        console.error(`[REMINDERS] ${garage.name}: send failed for ${c.phone} (code ${code}):`, err?.response?.data?.error?.message || err?.message);
        if (code === 131048 || code === 130429) break; // rate limited — stop this garage, retry tomorrow
      }
    }
  }

  console.log(`[REMINDERS] sweep done — garages:${garagesTouched} sent:${sent} wouldSend:${wouldSend} expired:${expired} armed:${armed}`);
  return { garages: garagesTouched, sent, wouldSend, expired };
}

export function initReminderCron(): void {
  // 09:15 UK — after the Garage Hive reminder job at 09:00, so the two never overlap.
  cron.schedule('15 9 * * *', () => {
    void runReminderSweep().catch((e) => console.error('[REMINDERS] sweep error', e));
  }, { timezone: 'Europe/London' });
  console.log(`✓ MOT/service reminder sweep scheduled: daily at 9:15 AM (UK) — ${schedulerArmed() ? 'ARMED' : 'DRY RUN (set REMINDER_SCHEDULER=on to arm)'}`);
}
