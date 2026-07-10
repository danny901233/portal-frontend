// ---------------------------------------------------------------------------
// Outbound campaign send — shared between the manual /send route and the daily
// Garage Hive reminder cron. Extracted verbatim from the original route so both
// paths use identical send + DNC + template logic.
// ---------------------------------------------------------------------------
import axios from 'axios';
import { prisma } from '../db.js';

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

/** Run the actual per-contact send loop and finalise the campaign status. */
export async function runCampaignSend(ctx: SendContext): Promise<{ sent: number; total: number }> {
  const { campaign, garageName, variableMapping, whatsappPhoneNumberId, accessToken, template } = ctx;

  const tierLimit = (campaign as any).tierLimit ?? 250;

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
  const availableQuota = Math.max(0, tierLimit - recentSentCount);

  if (availableQuota === 0) {
    console.log(`[OUTBOUND] Quota exhausted for garage ${campaign.garageId} (${recentSentCount} sent in 24h, limit ${tierLimit}). Queueing campaign ${campaign.id}.`);
    const resumeAt = new Date(Date.now() + 24.5 * 60 * 60 * 1000);
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
    } catch (err: unknown) {
      const metaError = (err as { response?: { data?: { error?: { message?: string; code?: number } } } })?.response?.data;
      const errorCode = metaError?.error?.code;

      if (errorCode === 131048) {
        console.log(`[OUTBOUND] Meta rate limit hit (131048) for campaign ${campaign.id}, keeping contact pending for retry`);
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

/** Process all queued campaigns whose resumeAt has passed. Called by the cron job. */
export async function processQueuedCampaigns(): Promise<{ processed: number }> {
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
