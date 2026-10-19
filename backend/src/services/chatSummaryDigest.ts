import { prisma } from '../db.js';
import { sendChatSummaryEmail } from '../utils/email.js';
import { getInstrumentedOpenAI, withAiContext } from '../utils/aiUsage.js';
import { sendArrearsCallNoticeEmail } from '../utils/email.js';
import { isGarageLocked } from '../utils/arrears.js';

/**
 * A summary email for EVERY chat conversation, the way the voice side has always sent one per
 * call (`sendCallSummaryEmail`).
 *
 * Chat only ever emailed the garage on a booking (`notifyChatBooking`) or an escalation
 * (`notifyMessaging`), so an enquiry that neither booked nor asked for a human — most of them —
 * happened entirely out of sight unless somebody opened the portal. Ecotest's clutch enquiry on
 * 19 Oct 2026 is the case in point: a real lead, no booking, no flag, no email.
 *
 * A chat has no hang-up, so "the conversation ended" is inferred from silence: a sweep runs every
 * ten minutes and summarises anything that has been quiet for IDLE_MINUTES. Each conversation is
 * claimed with a conditional UPDATE before the email is built, so two overlapping sweeps cannot
 * both send one.
 */

const IDLE_MINUTES = Number(process.env.CHAT_SUMMARY_IDLE_MINUTES || 20);
/** Older than this and it is history, not a conversation that has just finished. */
const MAX_AGE_HOURS = 24;

export interface SummaryDueInput {
  lastMessageAt: Date;
  summaryEmailSentAt: Date | null;
  /** How many messages the CUSTOMER sent. A widget nobody typed into is not a conversation. */
  userMessages: number;
  /** Nothing before this is ever summarised — the guard against emailing the back catalogue. */
  startAt: Date;
}

export function isDueForSummary(input: SummaryDueInput, now: Date = new Date()): boolean {
  const { lastMessageAt, summaryEmailSentAt, userMessages, startAt } = input;
  if (summaryEmailSentAt) return false;
  if (userMessages < 1) return false;
  if (lastMessageAt < startAt) return false;

  const quietMs = now.getTime() - lastMessageAt.getTime();
  if (quietMs < IDLE_MINUTES * 60_000) return false;
  if (quietMs > MAX_AGE_HOURS * 3_600_000) return false;
  return true;
}

/**
 * May this garage be sent what was actually said?
 *
 * Same rule as the call side (routes/calls.ts): an account in arrears is told a conversation was
 * handled and nothing of its content until the account is up to date, and an archived garage is
 * emailed nothing at all.
 *
 * Deliberately NOT gated on messagingNotifyEmail. That switch governs the per-message and
 * escalation alerts a garage opts into; this is the chat equivalent of the per-call summary,
 * which every garage gets. A conversation nobody hears about is the thing being fixed.
 */
export function summaryDelivery(
  garage: { accessRestricted?: boolean | null; paymentFailedAt?: Date | string | null; archivedAt?: Date | null },
  now: Date = new Date(),
): 'summary' | 'arrears-notice' | 'skip' {
  if (garage.archivedAt) return 'skip';
  if (isGarageLocked(garage, now)) return 'arrears-notice';
  return 'summary';
}

export interface ConversationShape {
  customerName: string | null;
  confirmedBooking: boolean;
  bookingDetails: string | null;
  session: Record<string, any>;
  firstUserMessage: string;
  needsAttention: boolean;
}

/**
 * One line saying what happened, without an AI call. Used as the fallback when the model is
 * unavailable, and as the prompt's starting point when it is.
 */
export function describeConversation(c: ConversationShape): string {
  const who = (c.customerName || '').trim() || 'A customer';
  const s = c.session || {};

  if (c.confirmedBooking && c.bookingDetails) {
    const vehicle = [s.vehicleMake, s.vehicleModel].filter(Boolean).join(' ').trim();
    const what = vehicle
      ? ` for their ${vehicle}${s.vrn ? ` (${s.vrn})` : ''}`
      : s.vrn ? ` for ${s.vrn}` : '';
    return `${who} booked ${c.bookingDetails}${what}.`;
  }

  if (c.needsAttention) {
    const wanted = String(s.message || s.messageReason || '').trim();
    return wanted ? `${who} needs a reply: ${trim(wanted, 180)}` : `${who} needs a reply.`;
  }

  const asked = trim(String(c.firstUserMessage || '').replace(/\s+/g, ' ').trim(), 150);
  return asked
    ? `${who} asked: "${asked}" No booking was made.`
    : `${who} started a chat and did not book.`;
}

function trim(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Ask the model for the one line a receptionist would write in the day book. Falls back to
 * `describeConversation` on any failure — the email matters more than the prose.
 */
async function aiSummary(
  transcript: Array<{ role: string; content: string }>,
  fallback: string,
  garageId: string,
  conversationId: string,
): Promise<string> {
  try {
    const openai = getInstrumentedOpenAI();
    const lines = transcript
      .map((m) => `${m.role === 'user' ? 'Customer' : 'Agent'}: ${String(m.content).slice(0, 400)}`)
      .join('\n')
      .slice(0, 6000);
    // The context is what attributes the spend to this garage in the AI usage ledger.
    const res = await withAiContext(
      { garageId, conversationId, channel: 'chat', agent: 'summary' },
      () => openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        temperature: 0.2,
        max_tokens: 120,
        messages: [
        {
          role: 'system',
          content: 'You write the one-line note a garage receptionist would leave about a '
            + 'customer conversation. Two sentences maximum. Say what the customer wanted, what '
            + 'was agreed, and anything still outstanding. No greeting, no sign-off, no '
            + 'speculation, and never invent a price, a date or a booking that is not in the '
            + 'conversation.',
        },
          { role: 'user', content: lines },
        ],
      }),
    );
    const out = (res.choices[0]?.message?.content || '').replace(/\s+/g, ' ').trim();
    return out || fallback;
  } catch (e: any) {
    console.error('[CHAT_SUMMARY] AI summary failed, using the plain one:', e?.message);
    return fallback;
  }
}

/**
 * Find conversations that have gone quiet, summarise each one and email the garage.
 *
 * Returns counts so the sweep can log a single line. Never throws: one bad conversation must not
 * stop the rest of the batch.
 */
export async function sendDueChatSummaries(options: {
  startAt: Date;
  limit?: number;
  now?: Date;
  useAi?: boolean;
  /** Restrict to these garages — for verifying the path against a test garage, or a pilot. */
  garageIds?: string[];
}): Promise<{ considered: number; sent: number; skipped: number; failed: number }> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;
  const useAi = options.useAi !== false;
  const idleBefore = new Date(now.getTime() - IDLE_MINUTES * 60_000);
  const notBefore = new Date(
    Math.max(options.startAt.getTime(), now.getTime() - MAX_AGE_HOURS * 3_600_000),
  );

  const candidates = await prisma.chatConversation.findMany({
    where: {
      summaryEmailSentAt: null,
      lastMessageAt: { lte: idleBefore, gte: notBefore },
      ...(options.garageIds?.length ? { garageId: { in: options.garageIds } } : {}),
    },
    orderBy: { lastMessageAt: 'asc' },
    take: limit,
    select: {
      id: true, garageId: true, platform: true, customerName: true, customerPhone: true,
      confirmedBooking: true, bookingDetails: true, capturedRevenue: true, needsAttention: true,
      sessionState: true, createdAt: true, lastMessageAt: true, summaryEmailSentAt: true,
    },
  });

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const conv of candidates) {
    try {
      const messages = await prisma.chatMessage.findMany({
        where: { conversationId: conv.id },
        orderBy: { createdAt: 'asc' },
        select: { role: true, content: true },
      });
      const userMessages = messages.filter((m) => m.role === 'user');

      if (!isDueForSummary({
        lastMessageAt: conv.lastMessageAt,
        summaryEmailSentAt: conv.summaryEmailSentAt,
        userMessages: userMessages.length,
        startAt: options.startAt,
      }, now)) {
        skipped += 1;
        continue;
      }

      const cfg = await prisma.agentConfiguration.findUnique({
        where: { garageId: conv.garageId },
        select: { branchName: true, notificationEmails: true },
      });
      const garage = await prisma.garage.findUnique({
        where: { id: conv.garageId },
        select: { accessRestricted: true, paymentFailedAt: true, archivedAt: true },
      });
      const to = (Array.isArray(cfg?.notificationEmails) ? cfg!.notificationEmails : [])
        .filter(Boolean) as string[];
      if (!to.length) {
        // Nowhere to send it. Stamped anyway so the sweep does not reconsider it every ten
        // minutes for the next day.
        await stamp(conv.id);
        skipped += 1;
        continue;
      }

      const delivery = garage ? summaryDelivery(garage, now) : 'skip';
      if (delivery === 'skip') {
        await stamp(conv.id);
        skipped += 1;
        continue;
      }

      // Claim it BEFORE sending. A duplicate summary is worse than a missing one, and the send
      // is the slow part — long enough for the next sweep to start.
      if (!(await stamp(conv.id))) {
        skipped += 1;
        continue;
      }

      if (delivery === 'arrears-notice') {
        await sendArrearsCallNoticeEmail(to, {
          branchName: cfg?.branchName || 'Your branch',
          createdAt: conv.createdAt.toISOString(),
          portalUrl: process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk',
        });
        console.log(`[CHAT_SUMMARY] ${conv.id}: garage in arrears — notice sent, content withheld`);
        sent += 1;
        continue;
      }

      const session = (conv.sessionState as Record<string, any>) || {};
      const shape: ConversationShape = {
        customerName: conv.customerName,
        confirmedBooking: conv.confirmedBooking,
        bookingDetails: conv.bookingDetails,
        session,
        firstUserMessage: userMessages[0]?.content || '',
        needsAttention: conv.needsAttention,
      };
      const plain = describeConversation(shape);
      const summary = useAi
        ? await aiSummary(messages, plain, conv.garageId, conv.id)
        : plain;

      await sendChatSummaryEmail(to, {
        branchName: cfg?.branchName || 'Your branch',
        platform: conv.platform,
        summary,
        customerName: conv.customerName,
        customerPhone: conv.customerPhone || session.contactPhone || null,
        customerEmail: session.contactEmail || null,
        registrationNumber: session.vrn || null,
        serviceName: session.serviceSelectedName || null,
        confirmedBooking: conv.confirmedBooking,
        capturedRevenue: conv.capturedRevenue ?? null,
        bookingDescription: conv.bookingDetails,
        createdAt: conv.createdAt.toISOString(),
        conversationId: conv.id,
      });
      sent += 1;
    } catch (e: any) {
      failed += 1;
      console.error(`[CHAT_SUMMARY] ${conv.id} failed:`, e?.message);
    }
  }

  return { considered: candidates.length, sent, skipped, failed };
}

/** Claim the conversation. False means somebody else already did. */
async function stamp(conversationId: string): Promise<boolean> {
  const { count } = await prisma.chatConversation.updateMany({
    where: { id: conversationId, summaryEmailSentAt: null },
    data: { summaryEmailSentAt: new Date() },
  });
  return count > 0;
}
