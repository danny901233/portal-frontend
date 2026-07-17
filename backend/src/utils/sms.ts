import twilio from 'twilio';

// Customer-facing SMS. Separate from utils/opsAlerts.ts, which is internal alerts to our own
// team on a fixed recipient list — this one takes an arbitrary number and is used to text a
// customer their agreement link.

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

// Alphanumeric sender, same as the messaging notifications use. One-way: replies go nowhere,
// so anything sent from here must not invite a reply.
const SMS_FROM = process.env.TWILIO_SMS_FROM || 'ReceptMate';

/**
 * Normalise a UK-entered mobile to E.164. Accepts "07…", "447…", "+447…", and passes through
 * an already-E.164 international number. Returns null when it can't be trusted — better to
 * refuse than to text a stranger.
 */
export function toE164UK(raw: string): string | null {
  const digits = (raw || '').replace(/[^\d+]/g, '');
  if (/^\+44\d{9,10}$/.test(digits)) return digits;
  if (/^44\d{9,10}$/.test(digits)) return `+${digits}`;
  if (/^0\d{9,10}$/.test(digits)) return `+44${digits.slice(1)}`;
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  return null;
}

/**
 * Send one SMS to a customer. Returns the E.164 number actually texted, or null on failure —
 * callers decide whether that's fatal (unlike ops alerts, a customer-facing send failing is
 * worth reporting).
 */
export async function sendCustomerSms(to: string, body: string): Promise<string | null> {
  const number = toE164UK(to);
  if (!number) {
    console.warn(`[SMS] refusing to send — "${to}" is not a valid number`);
    return null;
  }
  if (!twilioClient) {
    console.warn('[SMS] TWILIO credentials not configured — skipping');
    return null;
  }
  try {
    await twilioClient.messages.create({ to: number, from: SMS_FROM, body: body.slice(0, 1500) });
    console.log(`[SMS] sent to ${number}`);
    return number;
  } catch (err) {
    console.error(`[SMS] send to ${number} failed:`, err);
    return null;
  }
}
