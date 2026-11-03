import { prisma } from '../db.js';
import twilio from 'twilio';

/**
 * The booking confirmation text the agent has been promising since the feature shipped.
 *
 * `enableSmsBookingLinks` has been on for 41 of 69 garages, the agent prompt told the caller
 * "you'll get a confirmation link — it's sent automatically", and `SmsBookingLink` had zero rows
 * all time. Everything around the send existed — the model, the billing read in billing.ts, the
 * stats widget, `POST /api/sms/log`, the config toggle — and nothing sent anything. The agent
 * said it on 438 calls in 90 days and eight callers rang back asking where their text was; the
 * clearest pair is In'n'out Spalding 57797331 (20 Oct, £317 service and MOT, "You'll get a
 * confirmation text from us too") then 30367760 the next day from the same number.
 *
 * See receptionmate-agents#38. This is the missing piece, not a new feature.
 *
 * Deliberately NOT a link. The prompt said "link", but a link needs a public page, a token and a
 * route, none of which exist. The useful part of a confirmation is the date, the time and the
 * vehicle, and those fit in a sentence.
 */

// Same credentials and sender as messagingNotifications.ts, which has been sending to garages
// in production since it shipped. SMS_FROM defaults to an alphanumeric sender ID, so the
// recipient CANNOT REPLY — the body therefore has to tell them how to reach a human.
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;
const SMS_FROM = process.env.TWILIO_SMS_FROM || 'ReceptMate';

// The schema's own default for this table. Kept here so the billing row and the schema cannot
// drift apart silently.
const SMS_COST_GBP = 0.99;

/**
 * Which garages may send one, as a comma-separated list of garage ids.
 *
 * Unset means NOBODY, on purpose. 41 garages have `enableSmsBookingLinks` already switched on
 * from before the feature existed, so keying off that flag alone would start texting several
 * hundred real customers on the first deploy, from a sender ID they have never seen. The flag
 * is still required — this is a second lock, not a replacement.
 */
function allowedGarages(): Set<string> {
  return new Set(
    (process.env.BOOKING_SMS_GARAGE_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** UK mobile or landline in E.164, which is all Twilio will accept here. */
function normaliseUkNumber(raw: string | null | undefined): string | null {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+44') && digits.length >= 12) return digits;
  if (digits.startsWith('44') && digits.length >= 11) return `+${digits}`;
  if (digits.startsWith('0') && digits.length >= 10) return `+44${digits.slice(1)}`;
  return null;
}

/** "Thu 30 Oct, 9:00am" — London time, because the garage and the caller are both in it. */
export function formatWhen(at: Date): string {
  const d = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London',
  }).format(at);
  const t = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Europe/London',
  }).format(at).replace(/\s/g, '').toLowerCase();
  return `${d}, ${t}`;
}

export interface BookingSmsArgs {
  garageId: string;
  garageName: string;
  garagePhone?: string | null;
  customerPhone?: string | null;
  bookingAt?: Date | null;
  registrationNumber?: string | null;
  smsEnabled: boolean;
}

/**
 * The message. Exported so a test can assert the wording without a Twilio account.
 *
 * Returns null when there is nothing worth sending. A confirmation with no date in it is worse
 * than no confirmation: it tells the caller something is booked without saying when, and they
 * cannot reply to ask.
 */
export function buildBody(a: BookingSmsArgs): string | null {
  if (!a.bookingAt) return null;
  const reg = (a.registrationNumber || '').trim().toUpperCase();
  const phone = (a.garagePhone || '').trim();
  return [
    `Your booking at ${a.garageName} is confirmed for ${formatWhen(a.bookingAt)}.`,
    reg ? ` Vehicle: ${reg}.` : '',
    phone ? ` Any changes, please call ${phone}.` : '',
  ].join('');
}

/**
 * Send it, record it, and never throw.
 *
 * Fire-and-forget from the call-logging route, exactly like the push notification beside it —
 * a failed text must not fail the call record. Every refusal is logged with its reason, because
 * a silent no-op is how this feature came to look built for months while sending nothing.
 */
export async function sendBookingConfirmationSms(a: BookingSmsArgs): Promise<void> {
  try {
    if (!a.smsEnabled) return;

    const allow = allowedGarages();
    if (!allow.has(a.garageId)) {
      console.log(`[booking-sms] garage ${a.garageId} not in BOOKING_SMS_GARAGE_IDS — skipping`);
      return;
    }

    const to = normaliseUkNumber(a.customerPhone);
    if (!to) {
      console.log(`[booking-sms] no usable customer number for ${a.garageId} — skipping`);
      return;
    }

    const body = buildBody(a);
    if (!body) {
      console.log(`[booking-sms] no bookingAt for ${a.garageId} — nothing worth sending`);
      return;
    }

    if (!twilioClient) {
      console.warn('[booking-sms] TWILIO credentials not configured — skipping');
      return;
    }

    const msg = await twilioClient.messages.create({ to, from: SMS_FROM, body });
    console.log(`[booking-sms] sent to ${to.slice(0, 6)}… sid=${msg.sid}`);

    // Billing and the portal's SMS stats both read this table. A send with no row is a text
    // nobody is charged for and that no garage can see they received.
    await prisma.smsBookingLink
      .create({
        data: {
          garageId: a.garageId,
          phoneNumber: to,
          twilioMessageSid: msg.sid,
          status: 'sent',
          costGbp: SMS_COST_GBP,
        },
      })
      .catch((e) => console.error('[booking-sms] billing record failed', e));
  } catch (e) {
    console.error('[booking-sms] send failed', e);
  }
}
