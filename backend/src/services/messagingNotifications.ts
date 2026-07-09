import { prisma } from '../db.js';
import { sendEmail } from '../utils/email.js';
import twilio from 'twilio';

// Reuse the same Twilio credentials used for number provisioning. SMS also needs
// a sender number — set TWILIO_SMS_FROM to an SMS-capable Twilio number. Without
// it, SMS alerts are skipped (logged) rather than crashing the chat path.
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;
// Send from the same one-way alphanumeric sender ID the monitor/watchdog alerts
// use ('RMonitor') — proven working, so it doesn't depend on a phone number being
// SMS-capable. One-way is fine: recipients reply in the ReceptionMate inbox, not
// by SMS. Override with TWILIO_SMS_FROM if a different sender is ever wanted.
const SMS_FROM = process.env.TWILIO_SMS_FROM || 'RMonitor';

const SMS_COST_GBP = 0.2;

export type MessagingNotifyEvent = 'inbound' | 'escalated';

interface NotifyArgs {
  event: MessagingNotifyEvent;
  conversationId?: string;
  garageId?: string; // optional if conversationId is given
  preview?: string; // short snippet of the customer's message
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Alert a garage about chat activity per its messagingNotify* settings.
 *   scope 'off'       → never
 *   scope 'escalated' → only when a chat is handed to a human (event 'escalated')
 *   scope 'all'       → every inbound customer message (event 'inbound') AND escalations
 *
 * Fire-and-forget: call as `void notifyMessaging(...)` so it never blocks or breaks
 * the chat flow. All failures are swallowed + logged. Resolves the garage + customer
 * from conversationId when given.
 */
export async function notifyMessaging(args: NotifyArgs): Promise<void> {
  try {
    let customerName: string | null = null;
    let platform: string | null = null;
    let garageId = args.garageId || null;

    if (args.conversationId) {
      const conv = await prisma.chatConversation.findUnique({
        where: { id: args.conversationId },
        select: { garageId: true, customerName: true, platform: true },
      });
      if (conv) {
        garageId = conv.garageId;
        customerName = conv.customerName;
        platform = conv.platform;
      }
    }
    if (!garageId) return;

    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      include: { agentConfiguration: true },
    });
    const cfg = garage?.agentConfiguration as Record<string, unknown> | undefined;
    if (!cfg) return;

    const scope = (cfg.messagingNotifyScope as string) || 'off';
    if (scope === 'off') return;
    if (scope === 'escalated' && args.event !== 'escalated') return;
    // scope 'all' fires on both 'inbound' and 'escalated'.

    const who = (customerName || '').trim() || 'A customer';
    const channel = platform ? ` (${platform})` : '';
    const preview = (args.preview || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const garageName = garage?.name || 'your garage';
    const headline =
      args.event === 'escalated'
        ? `${who} needs a human on chat${channel}`
        : `New chat message from ${who}${channel}`;

    // EMAIL — reuse the garage's existing notification email list.
    if (cfg.messagingNotifyEmail === true) {
      const to = (Array.isArray(cfg.notificationEmails) ? cfg.notificationEmails : []).filter(
        Boolean,
      ) as string[];
      if (to.length) {
        await sendEmail({
          to,
          subject: `${headline} — ${garageName}`,
          text: `${headline}.${preview ? `\n\n"${preview}"` : ''}\n\nOpen your ReceptionMate inbox to reply.`,
          html: `<p>${escapeHtml(headline)}.</p>${
            preview ? `<blockquote>${escapeHtml(preview)}</blockquote>` : ''
          }<p>Open your ReceptionMate inbox to reply.</p>`,
        }).catch((e) => console.error('[msg-notify] email failed', e));
      }
    }

    // SMS — to the garage's notification phone, billed at £0.20 each.
    if (cfg.messagingNotifySms === true) {
      const to = ((cfg.messagingNotifyPhone as string) || '').trim();
      if (!to) {
        // No recipient number configured — nothing to do.
      } else if (!twilioClient || !SMS_FROM) {
        console.warn(
          '[msg-notify] SMS requested but TWILIO credentials / TWILIO_SMS_FROM not configured — skipping',
        );
      } else {
        try {
          const smsBody = preview
            ? `${headline}: "${preview.slice(0, 120)}" — reply in your ReceptionMate inbox.`
            : `${headline} — reply in your ReceptionMate inbox.`;
          const msg = await twilioClient.messages.create({ to, from: SMS_FROM, body: smsBody });
          await prisma.messagingNotificationSms
            .create({
              data: { garageId, phoneNumber: to, twilioMessageSid: msg.sid, costGbp: SMS_COST_GBP },
            })
            .catch((e) => console.error('[msg-notify] billing record failed', e));
        } catch (e) {
          console.error('[msg-notify] SMS send failed', e);
        }
      }
    }
  } catch (e) {
    console.error('[msg-notify] notifyMessaging error', e);
  }
}
