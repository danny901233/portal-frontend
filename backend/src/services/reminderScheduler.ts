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
import { sweepAbandonedCheckouts } from './abandonedCheckout.js';
import { prisma } from '../db.js';
import { normalisePhone, buildTemplateFields, activeHalt, haltOutboundForGarage } from './outboundSend.js';
import { daysUntil } from '../utils/dueDate.js';

/** Used when a reminder campaign somehow has no stages recorded. */
const DEFAULT_STAGES = [30, 14, 3];
/** Never send two reminders to the same person closer together than this. */
const MIN_GAP_DAYS = 7;
/** Fallback 24h send cap if a garage somehow has no limit recorded. Staff-adjustable per garage. */
const DEFAULT_TIER_LIMIT = 240;

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
  campaign: {
    id: string; campaignType: string; reminderStages: number[];
    stageTemplates: Record<string, string> | null;
    variableMapping: Record<string, string> | null;
  } | null;
};

export async function runReminderSweep(): Promise<{ garages: number; sent: number; wouldSend: number; expired: number }> {
  const armed = schedulerArmed();
  let sent = 0, wouldSend = 0, expired = 0, garagesTouched = 0;

  const garages = await prisma.garage.findMany({
    where: { hasMessagingAccess: true, accessRestricted: false },
    select: { id: true, name: true, dailyMessageLimit: true, twilioNumber: true },
  });

  for (const garage of garages) {
    // A garage stopped after a spam/policy error stays stopped — reminders included.
    const halt = await activeHalt(garage.id);
    if (halt) {
      console.log(`[REMINDERS] ${garage.name}: outbound halted (${halt.haltReason}) — skipping.`);
      continue;
    }

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
        campaign: {
          select: {
            id: true, campaignType: true, reminderStages: true,
            stageTemplates: true, variableMapping: true,
          },
        },
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
    //
    // A staged campaign names a template PER STAGE, because the whole point of a second and third
    // chase is that they do not say the same thing. Campaigns without that (every CSV upload, and
    // any run created before staging existed) keep using the seeded pair.
    const stageTemplateIds = new Set<string>();
    for (const { c, stage } of due) {
      const id = c.campaign?.stageTemplates?.[String(stage)];
      if (id) stageTemplateIds.add(id);
    }
    const stageTemplates = stageTemplateIds.size
      ? new Map(
          (await prisma.messageTemplate.findMany({
            where: { id: { in: [...stageTemplateIds] }, status: 'approved' },
            select: { id: true, name: true, language: true, variableSamples: true },
          })).map((t) => [t.id, t]),
        )
      : new Map();

    const template = await prisma.messageTemplate.findFirst({
      where: { garageId: garage.id, status: 'approved', name: { in: ['mot_reminder', 'service_reminder'] } },
      select: { name: true, language: true },
    });
    const wa = await prisma.socialMediaConnection.findFirst({
      where: { garageId: garage.id, platform: 'whatsapp', isActive: true },
      select: { whatsappPhoneNumberId: true, accessToken: true },
    });

    // Only the fallback path needs the seeded pair; a staged campaign brings its own.
    const haveAnyTemplate = !!template || stageTemplates.size > 0;
    if (!haveAnyTemplate || !wa?.whatsappPhoneNumberId || wa.whatsappPhoneNumberId === 'pending_setup') {
      console.log(`[REMINDERS] ${garage.name}: ${due.length} due but ${!haveAnyTemplate ? 'no approved template' : 'no WhatsApp connection'} — skipping`);
      continue;
    }

    // 24h cap, counted from what has actually gone out.
    const since = new Date(now - 24 * 60 * 60 * 1000);
    const sentLast24h = await prisma.outboundContact.count({
      where: { garageId: garage.id, status: 'sent', updatedAt: { gte: since } },
    });
    const quota = Math.max(0, (garage.dailyMessageLimit ?? DEFAULT_TIER_LIMIT) - sentLast24h);
    const batch = due.slice(0, quota);
    if (batch.length < due.length) {
      console.log(`[REMINDERS] ${garage.name}: capping at ${batch.length}/${due.length} (${sentLast24h} already sent in 24h)`);
    }

    for (const { c, stage } of batch) {
      if (!armed) {
        wouldSend++;
        const dryTemplate = stageTemplates.get(c.campaign?.stageTemplates?.[String(stage)] || '')?.name
          || template?.name || '(no template)';
        console.log(`[REMINDERS][DRY] ${garage.name}: would send ${stage}-day ${c.messageType} to ${c.phone} `
          + `via ${dryTemplate} (due ${c.dueDate?.toISOString().slice(0, 10)})`);
        continue;
      }
      try {
        const staged = stageTemplates.get(c.campaign?.stageTemplates?.[String(stage)] || '');
        if (!staged && !template) {
          console.log(`[REMINDERS] ${garage.name}: no approved template for the ${stage}-day stage — skipping ${c.registration}`);
          continue;
        }

        let parameters: Array<{ type: string; text: string }>;
        if (staged) {
          // The stage's own template, filled from its saved field assignments — the same mapping
          // the manual campaign sender uses, so a template behaves identically wherever it is
          // sent from and the garage is not editing two different ideas of variable {{1}}.
          const fields = buildTemplateFields({
            customerName: c.customerName,
            phone: c.phone,
            registration: c.registration,
            motDueDate: c.motDueDate,
            serviceDueDate: c.serviceDueDate,
            garageName: garage.name,
            garagePhone: garage.twilioNumber,
          });
          const samples = (staged.variableSamples as Record<string, string> | null) || {};
          const varNums = [...new Set(Object.keys(samples)
            .map((k) => /^\{\{(\d+)\}\}_field$/.exec(k)?.[1])
            .filter((n): n is string => !!n))].sort((a, b) => Number(a) - Number(b));
          parameters = varNums.map((n) => ({ type: 'text', text: fields[samples[`{{${n}}}_field`]] || '' }));
        } else {
          const firstName = c.customerName?.trim().split(/\s+/)[0] || c.customerName;
          const dueStr = c.motDueDate || c.serviceDueDate || '';
          // Variable order matches the seeded templates exactly:
          // 1 customer, 2 agent, 3 branch, 4 registration, 5 due date.
          parameters = [firstName, 'Leah', garage.name, (c.registration || '').toUpperCase(), dueStr]
            .map((text) => ({ type: 'text', text: text || '' }));
        }

        const res = await axios.post(
          `https://graph.facebook.com/v18.0/${wa.whatsappPhoneNumberId}/messages`,
          {
            messaging_product: 'whatsapp',
            to: normalisePhone(c.phone),
            type: 'template',
            template: {
              name: staged ? staged.name : template!.name,
              language: { code: (staged ? staged.language : template!.language) || 'en_GB' },
              ...(parameters.length > 0 && { components: [{ type: 'body', parameters }] }),
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
        // Spam / policy / eligibility: stop this garage entirely and email them, same as a
        // campaign send. Reminders are template traffic and carry exactly the same risk.
        if (code === 131048 || code === 368 || code === 131042) {
          await haltOutboundForGarage(garage.id, { code, metaMessage: err?.response?.data?.error?.message });
          break;
        }
        if (code === 130429) break; // throughput limit — stop this garage, retry tomorrow
      }
    }
  }

  console.log(`[REMINDERS] sweep done — garages:${garagesTouched} sent:${sent} wouldSend:${wouldSend} expired:${expired} armed:${armed}`);
  return { garages: garagesTouched, sent, wouldSend, expired };
}

export function initAbandonedCheckoutCron(): void {
  // Hourly, because the first email is due an hour after they go quiet — a slower tick would turn
  // "an hour" into "whenever the next run happens to be".
  //
  // 9am-6pm only. Somebody types their garage in at 10pm and an email landing at 11pm, from a
  // company they have barely met, reads as automated in the worst way. Holding it to the morning
  // costs nothing: of 46 prospects who never completed, every one went quiet within 30 minutes
  // and none ever came back, so a few hours changes no outcome.
  const armed = (process.env.ABANDONED_CHECKOUT_EMAILS || '').toLowerCase() === 'on';
  cron.schedule('20 9-18 * * *', () => {
    void sweepAbandonedCheckouts({ dryRun: !armed })
      .then((r) => {
        if (r.first || r.second) {
          console.log(`[ABANDONED] ${armed ? 'sent' : 'DRY RUN would send'} `
            + `${r.first} first + ${r.second} follow-up (${r.considered} considered, ${r.skipped} not due)`);
        }
      })
      .catch((e) => console.error('[ABANDONED] sweep error', e));
  }, { timezone: 'Europe/London' });
  console.log(`✓ Abandoned-checkout emails: hourly 9am-6pm (UK) — `
    + `${armed ? 'ARMED' : 'DRY RUN (set ABANDONED_CHECKOUT_EMAILS=on to arm)'}`);
}

export function initReminderCron(): void {
  // 09:15 UK — after the Garage Hive reminder job at 09:00, so the two never overlap.
  cron.schedule('15 9 * * *', () => {
    void runReminderSweep().catch((e) => console.error('[REMINDERS] sweep error', e));
  }, { timezone: 'Europe/London' });
  console.log(`✓ MOT/service reminder sweep scheduled: daily at 9:15 AM (UK) — ${schedulerArmed() ? 'ARMED' : 'DRY RUN (set REMINDER_SCHEDULER=on to arm)'}`);
}
