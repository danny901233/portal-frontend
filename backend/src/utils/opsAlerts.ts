// Internal ops SMS alerts (new leads, trial signups, etc.). Reuses the Twilio
// credentials + alphanumeric sender used by the messaging notifications / watchdog.
// Recipients: OPS_ALERT_SMS_TO (comma-separated), falling back to LEAD_ALERT_SMS_TO
// then the ops mobile. Best-effort: logs and swallows errors so it never affects
// the request path.
import twilio from 'twilio';

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

const SMS_FROM = process.env.TWILIO_SMS_FROM || 'ReceptMate';

const OPS_SMS_TO = (
  process.env.OPS_ALERT_SMS_TO ||
  process.env.LEAD_ALERT_SMS_TO ||
  '+447976500282'
)
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

/** Send a short internal SMS to the ops team. Never throws. */
export async function sendOpsSms(body: string): Promise<void> {
  if (OPS_SMS_TO.length === 0) return;
  if (!twilioClient) {
    console.warn('[OPS_ALERT] SMS requested but TWILIO credentials not configured — skipping SMS.');
    return;
  }
  for (const to of OPS_SMS_TO) {
    try {
      await twilioClient.messages.create({ to, from: SMS_FROM, body: body.slice(0, 1500) });
    } catch (err) {
      console.error(`[OPS_ALERT] SMS to ${to} failed:`, err);
    }
  }
}
