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
// One-way alphanumeric sender ID (max 11 chars, so not the full "ReceptionMate").
// Sends the same way as the monitor/watchdog alerts, so it doesn't depend on a
// phone number being SMS-capable. One-way is fine: recipients reply in the
// ReceptionMate inbox, not by SMS. Override with TWILIO_SMS_FROM if needed.
const SMS_FROM = process.env.TWILIO_SMS_FROM || 'ReceptMate';

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
 * Everything the garage needs to act without opening the portal: what the customer wants, which
 * vehicle, and how to reach them — followed by the tail of the conversation so the tone and any
 * detail the agent did not capture is visible too.
 *
 * Reads the agent's own session, so the "wanted" line is the note the agent recorded rather than
 * a second guess at it.
 */
async function buildEscalationSummary(
  conversationId: string,
  session: Record<string, any> | null,
): Promise<{ facts: Array<[string, string]>; transcript: Array<{ role: string; text: string }> }> {
  const s = session || {};
  const vehicle = [s.vehicleMake, s.vehicleModel].filter(Boolean).join(' ').trim();
  const job = s.serviceSelectedName || (s.outboundServiceType === 'mot' ? 'MOT' : '');

  const facts: Array<[string, string]> = [];
  if (s.customerNameFirst) {
    facts.push(['Customer', [s.customerNameFirst, s.customerNameLast].filter(Boolean).join(' ')]);
  }
  if (s.contactPhone) facts.push(['Best number', String(s.contactPhone)]);
  if (s.vrn) facts.push(['Vehicle', vehicle ? `${vehicle} (${s.vrn})` : String(s.vrn)]);
  else if (vehicle) facts.push(['Vehicle', vehicle]);
  if (job) facts.push(['Work', String(job)]);
  if (s.outboundServiceType) {
    const due = s.outboundDueDate ? `, due ${s.outboundDueDate}` : '';
    facts.push(['Came from', `${s.outboundServiceType === 'mot' ? 'MOT' : 'Service'} reminder${due}`]);
  }
  if (s.enquiryPreference) facts.push(['Preferred dates', String(s.enquiryPreference)]);
  if (s.bookingDate) {
    facts.push(['Slot', `${s.bookingDate}${s.bookingTime ? ` at ${s.bookingTime}` : ''}`]);
  }
  if (s.message) {
    // The recorded note ends with the same "Preferred dates: ..." clause that already has its own
    // line above, and printing both reads like a mistake. Drop the duplicate tail, and drop the
    // line entirely if that is all it was.
    let wanted = String(s.message);
    if (s.enquiryPreference) {
      wanted = wanted.replace(/\.?\s*Preferred dates:.*$/i, '').trim().replace(/[.,;]$/, '');
    }
    if (wanted) facts.push(['Wanted', wanted]);
  }
  if (s.notes) facts.push(['Notes', String(s.notes)]);

  let transcript: Array<{ role: string; text: string }> = [];
  try {
    const rows = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { role: true, content: true },
    });
    transcript = rows.reverse().map((r) => ({
      role: r.role === 'user' ? 'Customer' : 'Assistant',
      text: String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    })).filter((r) => r.text);
  } catch (e) {
    console.error('[msg-notify] could not load the transcript', e);
  }
  return { facts, transcript };
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
    let sessionState: Record<string, any> | null = null;

    if (args.conversationId) {
      const conv = await prisma.chatConversation.findUnique({
        where: { id: args.conversationId },
        select: { garageId: true, customerName: true, platform: true, sessionState: true },
      });
      if (conv) {
        garageId = conv.garageId;
        customerName = conv.customerName;
        platform = conv.platform;
        sessionState = (conv as any).sessionState || null;
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

    // An escalation is worth reading in the email. An inbound ping is not — it is one message
    // and the preview already carries it — so only pay for the extra query on escalations.
    let summaryText = '';
    let summaryHtml = '';
    let smsExtra = '';
    if (args.event === 'escalated' && args.conversationId) {
      const { facts, transcript } = await buildEscalationSummary(args.conversationId, sessionState);
      if (facts.length) {
        summaryText += '\n\n' + facts.map(([k, v]) => `${k}: ${v}`).join('\n');
        summaryHtml +=
          '<table cellpadding="0" cellspacing="0" style="margin:16px 0;font-size:14px">' +
          facts
            .map(
              ([k, v]) =>
                `<tr><td style="padding:2px 12px 2px 0;color:#64748b;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td>` +
                `<td style="padding:2px 0;color:#0f172a">${escapeHtml(v)}</td></tr>`,
            )
            .join('') +
          '</table>';
        const pref = facts.find(([k]) => k === 'Preferred dates');
        if (pref) smsExtra = ` Preferred: ${pref[1].slice(0, 60)}.`;
      }
      if (transcript.length) {
        summaryText +=
          '\n\nLast few messages:\n' + transcript.map((t) => `  ${t.role}: ${t.text}`).join('\n');
        summaryHtml +=
          '<p style="margin:16px 0 6px;color:#64748b;font-size:13px">Last few messages</p>' +
          '<div style="border-left:3px solid #e2e8f0;padding-left:12px;font-size:14px">' +
          transcript
            .map(
              (t) =>
                `<p style="margin:0 0 6px"><b style="color:#64748b;font-weight:600">${escapeHtml(t.role)}:</b> ${escapeHtml(t.text)}</p>`,
            )
            .join('') +
          '</div>';
      }
    }

    // EMAIL — reuse the garage's existing notification email list.
    if (cfg.messagingNotifyEmail === true) {
      const to = (Array.isArray(cfg.notificationEmails) ? cfg.notificationEmails : []).filter(
        Boolean,
      ) as string[];
      if (to.length) {
        await sendEmail({
          to,
          subject: `${headline} — ${garageName}`,
          text: `${headline}.${preview ? `\n\n"${preview}"` : ''}${summaryText}\n\nOpen your ReceptionMate inbox to reply.`,
          html: `<p style="font-size:15px"><b>${escapeHtml(headline)}.</b></p>${
            preview ? `<blockquote>${escapeHtml(preview)}</blockquote>` : ''
          }${summaryHtml}<p style="font-size:14px">Open your ReceptionMate inbox to reply.</p>`,
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
          // SMS is billed per message, so it stays short: headline, the one detail that decides
          // whether it is urgent, and where to reply.
          const smsBody = preview
            ? `${headline}: "${preview.slice(0, 120)}"${smsExtra} — reply in your ReceptionMate inbox.`
            : `${headline}.${smsExtra} — reply in your ReceptionMate inbox.`;
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
