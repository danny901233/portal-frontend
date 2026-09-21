// Endpoints for the voice support agent — the one that answers ReceptionMate's own phone.
//
//   POST /api/support/voice/identify  — who is calling, and what should the agent know about them
//   POST /api/support/voice/ticket    — raise a ticket into the existing support inbox
//
// Authenticated with the same X-Webhook-Secret the voice agents already use to log calls, so the
// agent needs no new credential.
//
// Identification is by caller ID, which is a hint and not proof: numbers are withheld, staff ring
// from mobiles, and a garage's landline may not be the number we hold. So this returns what it
// found and how confident it is, and the agent is instructed to confirm out loud rather than
// greet someone by the wrong company name.
//
// Deliberately NOT returned: anything the caller shouldn't hear read back by an agent that has
// only matched a phone number — bank details, invoice line items, call recordings, other
// branches' data. Enough to be useful, not enough to be a disclosure risk.

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { sendEmail } from '../utils/email.js';

const router = Router();

const TEAM_INBOX = process.env.SUPPORT_TEAM_INBOX || 'hello@receptionmate.co.uk';

function checkSecret(req: Request): boolean {
  const configured = process.env.WEBHOOK_SECRET;
  if (!configured) return true; // matches the convention in calls.ts — unset means open locally
  const provided = req.headers['x-webhook-secret'] ?? req.headers['webhook-secret'];
  if (Array.isArray(provided)) return provided.includes(configured);
  return provided === configured;
}

/** Last 9 digits, which is what actually distinguishes UK numbers once you strip +44/0/spaces. */
function tail(n: string | null | undefined): string {
  const digits = String(n || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

function money(pence: number): string {
  return '£' + (pence / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// identify
// ---------------------------------------------------------------------------

const identifySchema = z.object({
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email().max(200).optional(),
  company: z.string().trim().max(200).optional(),
});

router.post('/support/voice/identify', async (req: Request, res: Response) => {
  if (!checkSecret(req)) return res.status(401).json({ error: 'Invalid webhook secret' });

  const parsed = identifySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Bad request' });
  const { phone, email, company } = parsed.data;

  try {
    let matchedBy: 'email' | 'phone' | 'company' | null = null;
    let garages: { id: string; name: string; businessId: string | null }[] = [];

    // Email is the only identifier a caller actively gives us, so it outranks caller ID.
    if (email) {
      const user = await prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
        select: { garageAccessIds: true },
      });
      if (user?.garageAccessIds?.length) {
        garages = await prisma.garage.findMany({
          where: { id: { in: user.garageAccessIds }, archivedAt: null },
          select: { id: true, name: true, businessId: true },
        });
        if (garages.length) matchedBy = 'email';
      }
    }

    if (!garages.length && phone) {
      const t = tail(phone);
      if (t.length >= 9) {
        // Twilio numbers are stored in several formats, so match on the digit tail rather than
        // hoping the string happens to line up.
        const all = await prisma.garage.findMany({
          where: { archivedAt: null },
          select: { id: true, name: true, businessId: true, twilioNumber: true },
        });
        garages = all.filter((g) => tail(g.twilioNumber) === t)
                     .map(({ id, name, businessId }) => ({ id, name, businessId }));
        if (garages.length) matchedBy = 'phone';
      }
    }

    if (!garages.length && company) {
      garages = await prisma.garage.findMany({
        where: { name: { contains: company, mode: 'insensitive' }, archivedAt: null },
        select: { id: true, name: true, businessId: true },
        take: 3,
      });
      if (garages.length) matchedBy = 'company';
    }

    if (!garages.length) {
      return res.json({ known: false, matchedBy: null });
    }

    // Prefer the branch that has actually been taking calls — for a multi-branch business that is
    // almost always the one they are ringing about.
    const primary = garages[0];
    const full = await prisma.garage.findUnique({
      where: { id: primary.id },
      select: {
        id: true, name: true, businessId: true,
        subscriptionCostGbp: true, messagingSubscriptionCostGbp: true,
        hasVoiceAccess: true, hasMessagingAccess: true, accessRestricted: true,
        trialEndsAt: true, trialEndDate: true, paymentFailedAt: true,
        includedMinutes: true, twilioNumber: true,
        agentConfiguration: { select: { agentScript: true, agentName: true } },
        business: { select: { name: true } },
      },
    });
    if (!full) return res.json({ known: false, matchedBy: null });

    const now = new Date();
    const trialEnd = full.trialEndsAt || full.trialEndDate;
    const onTrial = !!(trialEnd && trialEnd > now);

    const [lastCall, callsThisMonth, lastInvoice] = await Promise.all([
      prisma.call.findFirst({
        where: { garageId: full.id }, orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      prisma.call.count({
        where: { garageId: full.id, createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) } },
      }),
      prisma.invoice.findFirst({
        where: { garageId: full.id }, orderBy: { createdAt: 'desc' },
        select: { status: true, total: true, createdAt: true, dueDate: true },
      }),
    ]);

    // Plain-language account state the agent can actually say out loud.
    const flags: string[] = [];
    if (onTrial) flags.push(`on trial until ${trialEnd!.toISOString().slice(0, 10)}`);
    if (full.accessRestricted) flags.push('account currently restricted for non-payment');
    if (full.paymentFailedAt) flags.push('a Direct Debit has failed recently');
    if (full.hasVoiceAccess === false) flags.push('voice is switched off on this account');
    if (!lastCall) flags.push('has never taken a call through us');
    else {
      const days = Math.floor((now.getTime() - lastCall.createdAt.getTime()) / 864e5);
      if (days > 14) flags.push(`no calls for ${days} days — forwarding may be off`);
    }

    return res.json({
      known: true,
      matchedBy,
      confidence: matchedBy === 'email' ? 'high' : matchedBy === 'phone' ? 'medium' : 'low',
      garage: {
        id: full.id,
        name: full.name,
        business: full.business?.name || null,
        number: full.twilioNumber || null,
      },
      branches: garages.map((g) => g.name),
      plan: {
        tier: full.agentConfiguration?.agentScript?.includes('Assist') ? 'Assist' : 'Automate',
        agentName: full.agentConfiguration?.agentName || 'Leah',
        monthly: Number(full.subscriptionCostGbp || 0) + Number(full.messagingSubscriptionCostGbp || 0),
        includedMinutes: full.includedMinutes,
        messaging: !!full.hasMessagingAccess,
        onTrial,
      },
      usage: { callsThisMonth, lastCallAt: lastCall?.createdAt ?? null },
      billing: lastInvoice
        ? { lastInvoice: money(lastInvoice.total), status: lastInvoice.status,
            raised: lastInvoice.createdAt.toISOString().slice(0, 10) }
        : null,
      flags,
    });
  } catch (err) {
    console.error('[SUPPORT_VOICE] identify failed:', err);
    // Never fail the call over this — the agent carries on as if it were an unknown caller.
    return res.json({ known: false, matchedBy: null, error: 'lookup_failed' });
  }
});

// ---------------------------------------------------------------------------
// ticket
// ---------------------------------------------------------------------------

const ticketSchema = z.object({
  reason: z.enum(['human_requested', 'cannot_answer', 'complaint', 'sales', 'other']),
  summary: z.string().trim().min(1).max(2000),
  callerName: z.string().trim().max(200).optional(),
  callerPhone: z.string().trim().max(40).optional(),
  callerEmail: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  garageId: z.string().trim().max(64).optional(),
  transcript: z.string().trim().max(20000).optional(),
  urgency: z.enum(['normal', 'urgent']).default('normal'),
});

router.post('/support/voice/ticket', async (req: Request, res: Response) => {
  if (!checkSecret(req)) return res.status(401).json({ error: 'Invalid webhook secret' });

  const parsed = ticketSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Bad request', detail: parsed.error.issues[0]?.message });
  }
  const t = parsed.data;

  try {
    // If we can tie the call to a portal login, the ticket belongs in that customer's existing
    // support thread — so the team sees the phone call alongside everything else from them,
    // rather than in a separate silo that has to be cross-referenced by hand.
    let user: { id: string; email: string } | null = null;
    if (t.callerEmail) {
      user = await prisma.user.findFirst({
        where: { email: { equals: t.callerEmail, mode: 'insensitive' } },
        select: { id: true, email: true },
      });
    }
    if (!user && t.garageId) {
      user = await prisma.user.findFirst({
        where: { garageAccessIds: { has: t.garageId } },
        select: { id: true, email: true },
        orderBy: { createdAt: 'asc' },
      });
    }

    const header = [
      `📞 Phone call — ${REASON_LABEL[t.reason]}`,
      t.callerName ? `Caller: ${t.callerName}` : null,
      t.callerPhone ? `Number: ${t.callerPhone}` : null,
      t.company ? `Company: ${t.company}` : null,
      t.urgency === 'urgent' ? 'Marked URGENT' : null,
    ].filter(Boolean).join('\n');

    const body = `${header}\n\n${t.summary}${t.transcript ? `\n\n— transcript —\n${t.transcript}` : ''}`;

    let conversationId: string | null = null;
    if (user) {
      const convo = await prisma.supportConversation.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
      });
      await prisma.supportMessage.create({
        data: {
          conversationId: convo.id,
          senderRole: 'customer',
          senderUserId: user.id,
          channel: 'voice',
          body,
        },
      });
      await prisma.supportConversation.update({
        where: { id: convo.id },
        data: {
          status: 'awaiting_staff',
          lastMessageAt: new Date(),
          lastMessageText: t.summary.slice(0, 200),
          unreadForStaff: { increment: 1 },
        },
      });
      conversationId = convo.id;
    }

    // Email the team either way. For a known customer this is the nudge to go and look at the
    // thread; for an unknown caller — someone ringing about signing up, or a customer whose
    // number we don't hold — it is the ticket, because there is no portal login to hang it on.
    const portalUrl = (process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk').replace(/\/$/, '');
    const link = conversationId ? `${portalUrl}/admin/support` : null;
    await sendEmail({
      to: [TEAM_INBOX],
      subject: `${t.urgency === 'urgent' ? '🔴 URGENT — ' : ''}Support call: ${REASON_LABEL[t.reason]}`
        + (t.company ? ` — ${t.company}` : t.callerName ? ` — ${t.callerName}` : ''),
      text: `${body}\n\n${link ? `Reply in the portal: ${link}` : 'No portal login matched — reply by phone or email.'}`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px">
        <h2 style="margin:0 0 6px;font-size:17px">Support call — ${escapeHtml(REASON_LABEL[t.reason])}</h2>
        <p style="margin:0 0 12px;color:#666;font-size:13px">
          ${escapeHtml(t.callerName || 'Caller unknown')}
          ${t.callerPhone ? ` · ${escapeHtml(t.callerPhone)}` : ''}
          ${t.company ? ` · ${escapeHtml(t.company)}` : ''}
          ${t.urgency === 'urgent' ? ' · <b style="color:#b42318">URGENT</b>' : ''}
        </p>
        <p style="margin:0 0 14px;white-space:pre-wrap">${escapeHtml(t.summary)}</p>
        ${link ? `<p><a href="${link}" style="background:#3426cf;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;display:inline-block">Open in the support inbox</a></p>`
               : '<p style="color:#666">No portal login matched this caller — reply by phone or email.</p>'}
        ${t.transcript ? `<hr style="border:none;border-top:1px solid #eee;margin:18px 0"/>
          <p style="color:#666;font-size:12px;white-space:pre-wrap">${escapeHtml(t.transcript)}</p>` : ''}
      </div>`,
    });

    console.log(`[SUPPORT_VOICE] ticket raised — ${t.reason}${conversationId ? ` → conversation ${conversationId}` : ' (no portal user)'}`);
    return res.json({ ok: true, conversationId, matchedUser: user?.email ?? null });
  } catch (err) {
    console.error('[SUPPORT_VOICE] ticket failed:', err);
    return res.status(500).json({ error: 'ticket_failed' });
  }
});

const REASON_LABEL: Record<string, string> = {
  human_requested: 'caller asked for a person',
  cannot_answer: 'agent could not answer',
  complaint: 'complaint',
  sales: 'new business enquiry',
  other: 'general',
};

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export default router;

// ---------------------------------------------------------------------------
// front door: demo slots + enquiry capture
//
// The slots are computed HERE, not in the agent, because the opening hours they have to sit
// inside live in the portal config and are edited there. An agent with its own idea of when we
// are open drifts the moment somebody changes the hours, and nobody finds out until a prospect
// is offered a demo on a Sunday.
// ---------------------------------------------------------------------------

/** The garage whose config represents US — our own opening hours, not a customer's. */
const FRONT_DOOR_GARAGE_ID =
  process.env.FRONT_DOOR_GARAGE_ID || 'd51dfa55-15d0-4d60-ad81-c675579d16f6';

const WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function londonToday(): Date {
  const now = new Date();
  const s = now.toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); // YYYY-MM-DD
  return new Date(`${s}T00:00:00Z`);
}

/**
 * Bookable demo times, soonest first.
 *
 * Never today — a demo agreed for two hours' time is one nobody has prepared for. Slots are on
 * the hour and must START at or after opening and FINISH at or before closing, so an hour-long
 * demo never runs past the end of the day.
 */
function demoSlotsFrom(hours: Record<string, { open?: string | null; close?: string | null; closed?: boolean }>,
                       weeks = 3, closures: Set<string> = new Set()): { date: string; time: string }[] {
  const out: { date: string; time: string }[] = [];
  const start = londonToday();
  for (let i = 1; i <= weeks * 7; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    if (closures.has(iso)) continue;
    const day = hours?.[WEEK[d.getUTCDay()]];
    if (!day || day.closed || !day.open || !day.close) continue;
    const openH = Number(String(day.open).slice(0, 2));
    const closeH = Number(String(day.close).slice(0, 2));
    const closeM = Number(String(day.close).slice(3, 5)) || 0;
    if (!Number.isFinite(openH) || !Number.isFinite(closeH)) continue;
    // Last start is one clear hour before closing.
    const lastStart = closeM > 0 ? closeH : closeH - 1;
    for (let h = openH; h <= lastStart; h++) out.push({ date: iso, time: `${String(h).padStart(2, '0')}:00` });
  }
  return out;
}

router.get('/support/voice/demo-slots', async (req: Request, res: Response) => {
  if (!checkSecret(req)) return res.status(401).json({ error: 'Unauthorised' });
  try {
    const cfg = await prisma.agentConfiguration.findUnique({
      where: { garageId: FRONT_DOOR_GARAGE_ID },
      select: { weeklyOpeningHours: true, bankHolidayDates: true },
    });
    const hours = (cfg?.weeklyOpeningHours ?? {}) as Record<string, { open?: string | null; close?: string | null; closed?: boolean }>;
    const closures = new Set(
      (Array.isArray(cfg?.bankHolidayDates) ? cfg!.bankHolidayDates : [])
        .map((b) => (b as { date?: string })?.date)
        .filter((d): d is string => typeof d === 'string'),
    );
    const slots = demoSlotsFrom(hours, 3, closures);
    return res.json({ ok: true, slots });
  } catch (err) {
    console.error('[frontdoor] demo-slots failed', err);
    return res.status(500).json({ ok: false, slots: [] });
  }
});

const enquirySchema = z.object({
  kind: z.string().trim().max(20).default('enquiry'),
  name: z.string().trim().max(200).nullable().optional(),
  company: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().max(200).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  branches: z.string().trim().max(100).nullable().optional(),
  dms: z.string().trim().max(100).nullable().optional(),
  volume: z.string().trim().max(200).nullable().optional(),
  interest: z.string().trim().max(2000).nullable().optional(),
  demo_date: z.string().trim().max(20).nullable().optional(),
  demo_time: z.string().trim().max(10).nullable().optional(),
  transcript: z.string().max(20000).nullable().optional(),
});

router.post('/support/voice/enquiry', async (req: Request, res: Response) => {
  if (!checkSecret(req)) return res.status(401).json({ error: 'Unauthorised' });
  const parsed = enquirySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'Invalid enquiry' });
  const d = parsed.data;

  const label = d.company || d.name || d.phone || 'Unknown caller';
  const demo = d.demo_date && d.demo_time ? `${d.demo_date} at ${d.demo_time}` : null;

  // HighLevel first, but never let it fail the call — the agent is mid-conversation and an
  // unreachable CRM must not turn into "sorry, something went wrong" in the caller's ear.
  let opportunityId: string | null = null;
  try {
    const { highlevelConfigured, upsertContact, createOpportunity } =
      await import('../services/highlevel.js');
    if (highlevelConfigured()) {
      // HL needs an email or a phone to identify a contact. A caller with neither is not a lead
      // we can act on, so don't create a contact for one — the email to the team still goes.
      if (d.email || d.phone) {
        const contact = await upsertContact({
          name: d.name || label,
          email: d.email || undefined,
          phone: d.phone || undefined,
          companyName: d.company || undefined,
        });
        if (contact.contactId) {
          const opp = await createOpportunity({
            contactId: contact.contactId,
            name: demo ? `${label} — demo ${demo}` : `${label} — phone enquiry`,
            kind: 'lead',
          });
          opportunityId = opp.id;
        }
      }
    }
  } catch (err) {
    console.error('[frontdoor] HighLevel push failed (continuing)', err);
  }

  const body = [
    demo ? `DEMO PENCILLED IN: ${demo} — needs confirming with them.` : `Kind: ${d.kind}`,
    '',
    `Name:      ${d.name || '—'}`,
    `Business:  ${d.company || '—'}`,
    `Email:     ${d.email || '—'}`,
    `Phone:     ${d.phone || '—'}`,
    `Branches:  ${d.branches || '—'}`,
    `Diary/DMS: ${d.dms || '—'}`,
    `Volume:    ${d.volume || '—'}`,
    '',
    `What they want:`,
    d.interest || '—',
    '',
    opportunityId ? `HighLevel opportunity: ${opportunityId}` : 'Not pushed to HighLevel.',
    '',
    d.transcript ? `--- transcript ---\n${d.transcript}` : '',
  ].join('\n');

  try {
    await sendEmail({
      to: TEAM_INBOX,
      subject: demo ? `Demo request — ${label} (${demo})` : `Phone enquiry — ${label}`,
      text: body,
    } as never);
  } catch (err) {
    console.error('[frontdoor] enquiry email failed', err);
  }

  console.log(`[frontdoor] ${d.kind} from ${label}${demo ? ` — demo ${demo}` : ''}`);
  return res.json({ ok: true, opportunityId });
});

/**
 * Put a phone caller through to the live demo agent.
 *
 * The front door and the demo agent register on the SAME LiveKit project
 * (receptionmate-i9q7193z), which is what makes this possible at all — an explicit dispatch adds
 * the demo agent to the room the caller is already in, so there is no transfer, no second call
 * leg and no hold music. The front door then stops talking and the demo agent takes over.
 */
router.post('/support/voice/live-demo', async (req: Request, res: Response) => {
  if (!checkSecret(req)) return res.status(401).json({ error: 'Unauthorised' });
  const room = String(req.body?.room || '').trim();
  if (!room) return res.status(400).json({ ok: false, error: 'room required' });

  const url = process.env.LIVEKIT_URL_SUPPORT || process.env.LIVEKIT_URL || '';
  const key = process.env.LIVEKIT_API_KEY_SUPPORT || process.env.LIVEKIT_API_KEY || '';
  const secret = process.env.LIVEKIT_API_SECRET_SUPPORT || process.env.LIVEKIT_API_SECRET || '';
  if (!url || !key || !secret) {
    console.error('[frontdoor] live demo: LiveKit credentials not configured');
    return res.status(500).json({ ok: false, error: 'not configured' });
  }

  try {
    const { AgentDispatchClient } = await import('livekit-server-sdk');
    const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const agentName = process.env.DEMO_AGENT_NAME || 'demo-agent-v2';
    const client = new AgentDispatchClient(httpUrl, key, secret);
    await client.createDispatch(room, agentName, {
      metadata: JSON.stringify({ source: 'frontdoor-phone' }),
    });
    console.log(`[frontdoor] dispatched ${agentName} into ${room}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[frontdoor] live demo dispatch failed', err);
    return res.status(500).json({ ok: false });
  }
});
