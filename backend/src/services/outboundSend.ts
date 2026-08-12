// ---------------------------------------------------------------------------
// Outbound campaign send — shared between the manual /send route and the daily
// Garage Hive reminder cron. Extracted verbatim from the original route so both
// paths use identical send + DNC + template logic.
// ---------------------------------------------------------------------------
import axios from 'axios';
import { prisma } from '../db.js';
import { sendEmail } from '../utils/email.js';

/** Normalise phone to E.164 format for Twilio and matching. */
export function normalisePhone(raw: string): string {
  let n = raw.replace(/^whatsapp:/i, '').replace(/[\s\-().]/g, '');
  if (/^07\d{9}$/.test(n)) n = `+44${n.slice(1)}`;
  else if (/^44\d{10}$/.test(n)) n = `+${n}`;
  return n;
}

/** Build the fallback plain-text message for a contact (SMS / debug only). */
export function buildMessage(
  customerName: string,
  messageType: string,
  dueDate: string,
  registration: string | null | undefined,
  garageName: string,
): string {
  const firstName = customerName.trim().split(/\s+/)[0];
  const reg = registration ? ` for your ${registration.toUpperCase()}` : '';
  if (messageType === 'service') {
    return `Hi ${firstName}, this is Leah from ${garageName}. Your${reg} is due a service on ${dueDate}. Would you like to book that in with me? Reply STOP to opt out.`;
  }
  return `Hi ${firstName}, this is Leah from ${garageName}. Your${reg} MOT is due on ${dueDate}. Would you like to book that in with me? Reply STOP to opt out.`;
}

type SendableCampaign = NonNullable<Awaited<ReturnType<typeof loadCampaign>>>;

function loadCampaign(id: string) {
  return prisma.outboundCampaign.findUnique({
    where: { id },
    include: { contacts: { where: { status: 'pending' } } },
    // Note: resumeAt, tierLimit, sentCount are on the model but not in the TS type — accessed via (campaign as any)
  });
}

export interface SendContext {
  campaign: SendableCampaign;
  garageName: string;
  variableMapping: Record<string, string>;
  whatsappPhoneNumberId: string;
  accessToken: string;
  template: { name: string; language: string | null; bodyText: string } | null;
}

export type SendContextResult =
  | { ok: true; ctx: SendContext }
  | { ok: false; code: number; error: string };

/**
 * Look up everything needed to send a campaign and validate it's sendable.
 * On failure, resets the campaign to draft so it can be retried, and returns a
 * structured error (no side-effects on success beyond the read).
 */
export async function getCampaignSendContext(campaignId: string): Promise<SendContextResult> {
  const campaign = await loadCampaign(campaignId);
  if (!campaign) return { ok: false, code: 404, error: 'Campaign not found' };
  if (campaign.status === 'sent') return { ok: false, code: 400, error: 'Campaign already sent' };

  // A halt covers the whole garage, so this has to be checked before anything else.
  const halt = await activeHalt(campaign.garageId);
  if (halt) {
    const until = new Date(new Date(halt.haltedAt!).getTime() + HALT_COOLDOWN_HOURS * 60 * 60 * 1000);
    return {
      ok: false,
      code: 423,
      error: `Outbound messaging is paused for this garage. ${halt.haltReason} Sending can resume after ${until.toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' })}. Please don't re-send the same list — reply to the email we sent and we'll go through it with you.`,
    };
  }
  if (campaign.status === 'halted') {
    return { ok: false, code: 423, error: (campaign as any).haltReason || 'This campaign was stopped.' };
  }
  if (campaign.status === 'queued') {
    const resumeAt = (campaign as any).resumeAt ? new Date((campaign as any).resumeAt).toISOString() : 'unknown';
    return { ok: false, code: 400, error: `Campaign is queued and will automatically send the next batch at ${resumeAt}. Please wait for the daily limit to reset.` };
  }
  if (campaign.contacts.length === 0) {
    return { ok: false, code: 400, error: 'No pending contacts to send to' };
  }

  const [agentConfig, waConnection, template] = await Promise.all([
    prisma.agentConfiguration.findUnique({
      where: { garageId: campaign.garageId },
      select: { branchName: true },
    }),
    prisma.socialMediaConnection.findFirst({
      where: { garageId: campaign.garageId, platform: 'whatsapp', isActive: true },
      select: { whatsappPhoneNumberId: true, accessToken: true },
    }),
    campaign.messageTemplateId
      ? prisma.messageTemplate.findUnique({
          where: { id: campaign.messageTemplateId },
          select: { name: true, language: true, bodyText: true },
        })
      : Promise.resolve(null),
  ]);

  if (!waConnection?.whatsappPhoneNumberId || waConnection.whatsappPhoneNumberId === 'pending_setup') {
    await prisma.outboundCampaign.update({ where: { id: campaign.id }, data: { status: 'draft' } });
    return { ok: false, code: 400, error: 'No WhatsApp sender configured for this garage' };
  }
  if (campaign.channel === 'whatsapp' && !template) {
    await prisma.outboundCampaign.update({ where: { id: campaign.id }, data: { status: 'draft' } });
    return {
      ok: false,
      code: 400,
      error: 'WhatsApp campaigns require an approved template. Please select a template and try again.',
    };
  }

  return {
    ok: true,
    ctx: {
      campaign,
      garageName: agentConfig?.branchName || 'our garage',
      variableMapping: (campaign.variableMapping as Record<string, string> | null) || {},
      whatsappPhoneNumberId: waConnection.whatsappPhoneNumberId,
      accessToken: waConnection.accessToken,
      template,
    },
  };
}

/**
 * Pacing. Meta will happily accept a few hundred template sends in under a minute, so nothing
 * stops us firing the whole batch at once — but a brand-new WhatsApp number that sends 250 cold
 * templates in 90 seconds is the exact shape of a spam run, and quality rating drops on the
 * first handful of "block" taps. Midlands Motorhome Hire sent 151 in a single minute on
 * 2026-07-08, collected 510 "spam rate limit" errors, and the number was gone by the 13th.
 *
 * One message every 30 seconds is 120/hour. Inside the sending window below that is still ~1,300
 * a day — comfortably more than the 250/day cap almost every garage is on — so the slow rate
 * costs nothing in practice and makes a burst impossible.
 */
const SEND_GAP_MS = 30_000;
/** Jitter so sends don't land on a metronome. */
const SEND_GAP_JITTER_MS = 6_000;

/**
 * Sending window, UK time. At one message every 30s a big list runs for hours, and a reminder
 * arriving at 2am reads as spam no matter how politely it is worded. Outside the window the
 * batch is queued and picks up the next morning.
 */
const SEND_WINDOW_START_HOUR = 8;
const SEND_WINDOW_END_HOUR = 20;

function ukHour(at = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }).format(at),
  );
}

function withinSendWindow(at = new Date()): boolean {
  const h = ukHour(at);
  return h >= SEND_WINDOW_START_HOUR && h < SEND_WINDOW_END_HOUR;
}

/** Next 08:00 UK from now, as a rough resume point (an hour's slack is fine here). */
function nextWindowOpen(): Date {
  const now = new Date();
  const h = ukHour(now);
  const hoursAhead = h < SEND_WINDOW_START_HOUR
    ? SEND_WINDOW_START_HOUR - h
    : 24 - h + SEND_WINDOW_START_HOUR;
  return new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
}

/**
 * Meta errors that mean "stop", not "retry". These are the ones that precede a number being
 * disabled, so they halt the whole garage rather than just the current batch.
 */
const HALT_CODES: Record<number, string> = {
  131048: 'WhatsApp flagged these messages as spam and stopped delivering them.',
  368: 'WhatsApp has temporarily blocked this number for a policy violation.',
  131042: 'WhatsApp reports a billing or business-eligibility problem on this account.',
};
/** Throughput limits — pause and resume, no halt. */
const PAUSE_CODES = new Set([130429]);
/** How long a halt keeps the whole garage from sending. */
const HALT_COOLDOWN_HOURS = 24;

/**
 * Warm-up ceiling for a number with little history, stricter than Meta's own tier limit.
 * Anything over the ceiling is queued for tomorrow by the existing resume logic, so nothing is
 * dropped — it just goes out over a few days instead of one afternoon.
 */
function warmupCeiling(everSent: number): number {
  if (everSent < 50) return 50;      // first send from this number
  if (everSent < 250) return 150;
  return Number.POSITIVE_INFINITY;   // established — Meta's tier limit is the only cap
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Is this garage currently stopped after a policy/spam error? Returns the halt if so.
 * Checked before every send, so a halt blocks the whole garage — not just the campaign that
 * triggered it. Re-running the same list minutes later is exactly how an account gets banned
 * rather than warned.
 */
export async function activeHalt(garageId: string) {
  return prisma.outboundCampaign.findFirst({
    where: { garageId, haltedAt: { gte: new Date(Date.now() - HALT_COOLDOWN_HOURS * 60 * 60 * 1000) } },
    orderBy: { haltedAt: 'desc' },
    select: { id: true, name: true, haltedAt: true, haltReason: true },
  });
}

/**
 * Stop everything for this garage and tell someone. Halts the campaign that hit the error plus
 * anything queued behind it, so tomorrow's automatic resume doesn't walk into the same wall.
 */
export async function haltOutboundForGarage(
  garageId: string,
  args: { code: number; campaignId?: string; metaMessage?: string },
): Promise<void> {
  const reason = HALT_CODES[args.code] || `WhatsApp returned error ${args.code}.`;
  const haltedAt = new Date();

  await prisma.outboundCampaign.updateMany({
    where: {
      garageId,
      OR: [
        ...(args.campaignId ? [{ id: args.campaignId }] : []),
        { status: { in: ['sending', 'queued'] } },
      ],
    },
    data: { status: 'halted', haltedAt, haltReason: reason },
  });

  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { name: true, agentConfiguration: { select: { notificationEmails: true } } },
  });
  const garageName = garage?.name || 'your garage';
  console.error(`[OUTBOUND] HALTED ${garageName} (${garageId}) — ${args.code}: ${reason}`);

  const garageEmails = (garage?.agentConfiguration?.notificationEmails || []).filter(Boolean);
  const opsEmail = process.env.OPS_ALERT_EMAIL_TO || process.env.LEAD_ALERT_EMAIL_TO || '';
  const to = [...new Set([...garageEmails, ...opsEmail.split(',').map((e) => e.trim()).filter(Boolean)])];
  if (to.length === 0) {
    console.warn(`[OUTBOUND] No notification address for ${garageName} — halt email not sent.`);
    return;
  }

  const subject = `Outbound messaging stopped — ${garageName}`;
  const detail = args.metaMessage ? `<p style="color:#64748b;font-size:13px;">WhatsApp said: “${escapeHtml(args.metaMessage)}”</p>` : '';
  await sendEmail({
    to,
    subject,
    text:
      `We have stopped your outbound WhatsApp messages.

${reason}

` +
      `Nothing further will be sent for ${HALT_COOLDOWN_HOURS} hours. This is a protection: ` +
      `carrying on after a warning like this is what gets a WhatsApp number permanently disabled.

` +
      `What to do next:
` +
      `- Don't re-send the same list.
` +
      `- Check the message reads as something your customers asked to receive.
` +
      `- Offers and promotions must use a MARKETING template, not a UTILITY one.

` +
      `Reply to this email and we'll take a look with you.`,
    html: emailShell(`
      <h2 style="margin:0 0 12px;font-size:20px;color:#0f172a;">Outbound messaging stopped</h2>
      <p style="color:#334155;">We've stopped sending your outbound WhatsApp messages for ${garageName}.</p>
      <p style="background:#fef2f2;border-left:3px solid #ef4444;padding:12px 14px;color:#7f1d1d;margin:16px 0;">
        ${escapeHtml(reason)}
      </p>
      ${detail}
      <p style="color:#334155;">Nothing further will be sent for ${HALT_COOLDOWN_HOURS} hours. This is deliberate —
      carrying on after a warning like this is what gets a WhatsApp number permanently disabled.</p>
      <p style="color:#0f172a;font-weight:600;margin-bottom:4px;">What to do next</p>
      <ul style="color:#334155;padding-left:18px;margin-top:0;">
        <li>Don't re-send the same list.</li>
        <li>Check the message reads as something your customers asked to receive.</li>
        <li>Offers and promotions need a MARKETING template, not a UTILITY one.</li>
      </ul>
      <p style="color:#334155;">Reply to this email and we'll go through it with you.</p>
    `),
  }).catch((e) => console.error('[OUTBOUND] halt email failed', e));
}

/**
 * Minimal self-contained wrapper. Deliberately not the shared branded shell — this alert has to
 * send even when the rest of the email module is a different version to this file.
 */
function emailShell(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f1f2f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f2f9;">
    <tr><td style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="margin:0 auto;background:#ffffff;border-radius:14px;">
        <tr><td style="padding:28px;">${bodyHtml}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Run the actual per-contact send loop and finalise the campaign status. */
export async function runCampaignSend(ctx: SendContext): Promise<{ sent: number; total: number }> {
  const { campaign, garageName, variableMapping, whatsappPhoneNumberId, accessToken, template } = ctx;

  // The garage-level cap is the real ceiling: staff-set, deliberately under Meta's tier, and
  // counted across every campaign. The per-campaign tierLimit stays as a stricter-only override.
  const garageLimits = await prisma.garage.findUnique({
    where: { id: campaign.garageId },
    select: { dailyMessageLimit: true },
  });
  const dailyLimit = garageLimits?.dailyMessageLimit ?? 240;
  const tierLimit = Math.min((campaign as any).tierLimit ?? dailyLimit, dailyLimit);

  // Rolling 24h cross-campaign quota check — Meta's tier limit counts messages
  // DELIVERED to unique numbers, not API calls made. Failed deliveries don't count.
  // Count contacts with status sent/delivered/read/replied (exclude failed/pending/opted_out).
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentSentCount = await prisma.outboundContact.count({
    where: {
      garageId: campaign.garageId,
      status: { in: ['sent', 'delivered', 'read', 'replied'] },
      updatedAt: { gte: twentyFourHoursAgo },
    },
  });
  // How much this number has ever sent, which is what decides whether it is still warming up.
  const everSent = await prisma.outboundContact.count({
    where: { garageId: campaign.garageId, status: { in: ['sent', 'delivered', 'read', 'replied'] } },
  });
  const ceiling = warmupCeiling(everSent);
  const effectiveLimit = Math.min(tierLimit, ceiling);
  if (ceiling < tierLimit) {
    console.log(`[OUTBOUND] Garage ${campaign.garageId} is warming up (${everSent} ever sent) — capping this batch at ${ceiling} rather than ${tierLimit}.`);
  }
  const availableQuota = Math.max(0, effectiveLimit - recentSentCount);

  if (availableQuota === 0) {
    console.log(`[OUTBOUND] Quota exhausted for garage ${campaign.garageId} (${recentSentCount} sent in 24h, limit ${tierLimit}). Queueing campaign ${campaign.id}.`);
    const resumeAt = new Date(Date.now() + 24.5 * 60 * 60 * 1000);
    await prisma.outboundCampaign.update({
      where: { id: campaign.id },
      data: { status: 'queued', resumeAt },
    });
    return { sent: 0, total: campaign.contacts.length };
  }

  // Outside the window, do nothing but queue — a template landing at 2am reads as spam however
  // politely it's worded, and at one message per 30s a long list would otherwise run into the night.
  if (!withinSendWindow()) {
    const resumeAt = nextWindowOpen();
    console.log(`[OUTBOUND] Outside sending hours — queueing campaign ${campaign.id} until ${resumeAt.toISOString()}`);
    await prisma.outboundCampaign.update({
      where: { id: campaign.id },
      data: { status: 'queued', resumeAt },
    });
    return { sent: 0, total: campaign.contacts.length };
  }

  const optedOut = await prisma.outboundContact.findMany({
    where: { garageId: campaign.garageId, status: 'opted_out' },
    select: { phone: true },
  });
  const dncSet = new Set(optedOut.map((c) => c.phone));

  let sentCount = 0;
  let rateLimitHit = false;

  for (const contact of campaign.contacts) {
    if (!withinSendWindow()) {
      console.log(`[OUTBOUND] Sending window closed mid-batch — pausing campaign ${campaign.id}.`);
      break;
    }
    if (sentCount >= availableQuota) {
      console.log(`[OUTBOUND] Reached quota (${sentCount}/${availableQuota}) for campaign ${campaign.id}, stopping batch.`);
      break;
    }

    if (dncSet.has(contact.phone)) {
      console.log(`[OUTBOUND] Skipping DNC number ${contact.phone}`);
      await prisma.outboundContact.update({ where: { id: contact.id }, data: { status: 'opted_out' } });
      continue;
    }

    try {
      const e164 = normalisePhone(contact.phone);
      const contactFields: Record<string, string> = {
        customer_name: contact.customerName?.trim().split(/\s+/)[0] || contact.customerName,
        full_name: contact.customerName,
        phone: contact.phone,
        registration: contact.registration?.toUpperCase() || '',
        mot_due_date: contact.motDueDate || '',
        service_due_date: contact.serviceDueDate || '',
        garage_name: garageName,
      };

      let payload: Record<string, unknown>;
      if (template && campaign.messageTemplateId) {
        const parameters = Object.keys(variableMapping)
          .sort((a, b) => Number(a) - Number(b))
          .map((varNum) => ({ type: 'text', text: contactFields[variableMapping[varNum]] || '' }));
        payload = {
          messaging_product: 'whatsapp',
          to: e164,
          type: 'template',
          template: {
            name: template.name,
            language: { code: template.language || 'en_GB' },
            ...(parameters.length > 0 && { components: [{ type: 'body', parameters }] }),
          },
        };
      } else {
        const dueDate = contact.motDueDate || contact.serviceDueDate || 'soon';
        const body = buildMessage(contact.customerName, contact.messageType, dueDate, contact.registration, garageName);
        payload = { messaging_product: 'whatsapp', to: e164, type: 'text', text: { body } };
      }

      const metaRes = await axios.post(
        `https://graph.facebook.com/v18.0/${whatsappPhoneNumberId}/messages`,
        payload,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const messageSid = metaRes.data?.messages?.[0]?.id || null;

      await prisma.outboundContact.update({
        where: { id: contact.id },
        data: { status: 'sent', messageSid },
      });
      sentCount++;

      // Drip. Only between sends, so a one-contact campaign is still instant.
      if (sentCount < availableQuota) {
        await sleep(SEND_GAP_MS + Math.floor(Math.random() * SEND_GAP_JITTER_MS));
      }
    } catch (err: unknown) {
      const metaError = (err as { response?: { data?: { error?: { message?: string; code?: number } } } })?.response?.data;
      const errorCode = metaError?.error?.code;

      // Spam / policy / eligibility: stop the whole garage and tell them why. This is the
      // difference between a warning and a permanently disabled number.
      if (errorCode && HALT_CODES[errorCode]) {
        await prisma.outboundContact.update({
          where: { id: contact.id },
          data: { status: 'failed', errorReason: metaError?.error?.message || `Halted (${errorCode})` },
        });
        await haltOutboundForGarage(campaign.garageId, {
          code: errorCode,
          campaignId: campaign.id,
          metaMessage: metaError?.error?.message,
        });
        return { sent: sentCount, total: campaign.contacts.length };
      }

      // Throughput limit — not a quality signal. Pause and retry later.
      if (errorCode && PAUSE_CODES.has(errorCode)) {
        console.log(`[OUTBOUND] Throughput limit (${errorCode}) on campaign ${campaign.id}, keeping contact pending for retry`);
        rateLimitHit = true;
        break;
      }

      console.error(`[OUTBOUND] Failed to send to ${contact.phone}:`, metaError ?? err);
      const errorReason = metaError?.error?.message || 'Send failed';
      await prisma.outboundContact.update({
        where: { id: contact.id },
        data: { status: 'failed', errorReason },
      });
    }
  }

  // Check remaining pending contacts
  const remainingPending = await prisma.outboundContact.count({
    where: { campaignId: campaign.id, status: 'pending' },
  });

  const existingSentCount = campaign.sentCount ?? 0;
  const totalSent = existingSentCount + sentCount;

  let finalStatus: string;
  if (remainingPending > 0) {
    const resumeAt = new Date(Date.now() + 24.5 * 60 * 60 * 1000);
    finalStatus = 'queued';
    await prisma.outboundCampaign.update({
      where: { id: campaign.id },
      data: { status: 'queued', sentAt: new Date(), sentCount: totalSent, resumeAt },
    });
    console.log(`[OUTBOUND] Campaign ${campaign.id} queued: ${sentCount} sent this batch, ${remainingPending} remaining. Resume at ${resumeAt.toISOString()}`);
  } else {
    finalStatus = sentCount === 0 && totalSent === 0 ? 'failed' : 'processed';
    await prisma.outboundCampaign.update({
      where: { id: campaign.id },
      data: { status: finalStatus, sentAt: new Date(), sentCount: totalSent },
    });
    console.log(`[OUTBOUND] Campaign ${campaign.id} ${finalStatus}: ${totalSent} total sent`);
  }

  return { sent: sentCount, total: campaign.contacts.length };
}

/**
 * A campaign left 'sending' with contacts still pending was interrupted — the process restarted
 * mid-batch. Paced sends take ten-plus minutes, so this window is real, and nothing else would
 * ever pick those contacts up: the resume path only looks at 'queued'. Anything stuck for over
 * an hour is handed back to the queue.
 */
async function requeueStalledSends(): Promise<number> {
  const stalled = await prisma.outboundCampaign.findMany({
    where: {
      status: 'sending',
      updatedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
      contacts: { some: { status: 'pending' } },
    },
    select: { id: true, name: true },
  });
  for (const s of stalled) {
    console.warn(`[OUTBOUND-CRON] Campaign ${s.name} (${s.id}) stalled mid-send — requeueing.`);
    await prisma.outboundCampaign.update({
      where: { id: s.id },
      data: { status: 'queued', resumeAt: new Date() },
    });
  }
  return stalled.length;
}

/** Process all queued campaigns whose resumeAt has passed. Called by the cron job. */
export async function processQueuedCampaigns(): Promise<{ processed: number }> {
  await requeueStalledSends();
  // After the requeue, so anything just handed back is picked up on this same run.
  const now = new Date();
  const queuedCampaigns = await prisma.outboundCampaign.findMany({
    where: { status: 'queued', resumeAt: { lte: now } },
    select: { id: true, name: true },
  });

  if (queuedCampaigns.length === 0) return { processed: 0 };

  let processed = 0;
  for (const qc of queuedCampaigns) {
    console.log(`[OUTBOUND-CRON] Processing queued campaign: ${qc.name} (${qc.id})`);
    try {
      // Set to 'sending' before calling sendCampaignById so getCampaignSendContext doesn't block it
      await prisma.outboundCampaign.update({ where: { id: qc.id }, data: { status: 'sending' } });
      const result = await sendCampaignById(qc.id);
      if (result.ok) {
        console.log(`[OUTBOUND-CRON] Campaign ${qc.id}: sent ${result.sent}/${result.total}`);
      } else {
        console.error(`[OUTBOUND-CRON] Campaign ${qc.id} failed: ${result.error}`);
      }
      processed++;
    } catch (error) {
      console.error(`[OUTBOUND-CRON] Campaign ${qc.id} error:`, error);
    }
  }

  return { processed };
}

/**
 * Validate + send a campaign to completion (awaits the full send). Used by the
 * daily reminder cron. Returns a structured result rather than throwing.
 */
export async function sendCampaignById(
  campaignId: string,
): Promise<{ ok: boolean; error?: string; sent?: number; total?: number }> {
  const prepared = await getCampaignSendContext(campaignId);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  await prisma.outboundCampaign.update({ where: { id: campaignId }, data: { status: 'sending' } });
  const { sent, total } = await runCampaignSend(prepared.ctx);
  return { ok: true, sent, total };
}
