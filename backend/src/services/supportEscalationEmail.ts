// Email the ReceptionMate team when Leah escalates a support conversation.
// The customer keeps chatting with Leah; the team picks up async via email.

import { sendEmail } from '../utils/email.js';
import { prisma } from '../db.js';

const TEAM_INBOX = 'hello@receptionmate.co.uk';

export async function sendSupportEscalationEmail(args: {
  conversationId: string;
  triggerMessage: string;
  customerEmail: string;
}): Promise<void> {
  const portalUrl = (process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk').replace(/\/$/, '');

  // Grab the last ~10 messages for context.
  const recent = await prisma.supportMessage.findMany({
    where: { conversationId: args.conversationId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  const transcript = recent.reverse(); // oldest first

  const transcriptHtml = transcript
    .map((m) => {
      const time = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      }).format(m.createdAt);
      const who =
        m.senderRole === 'customer'
          ? `<strong>${escapeHtml(args.customerEmail)}</strong>`
          : m.senderRole === 'ai'
          ? '<strong>Leah (AI)</strong>'
          : m.senderRole === 'staff'
          ? '<strong>Staff</strong>'
          : '<em>System</em>';
      return `<p style="margin:0 0 8px;"><span style="color:#64748b;font-size:11px;">${time}</span> &middot; ${who}<br/>${escapeHtml(m.body).replace(/\n/g, '<br/>')}</p>`;
    })
    .join('');

  const ticketUrl = `${portalUrl}/admin/support`;

  const subject = `New support ticket from ${args.customerEmail}`;
  const html = `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:680px;margin:0 auto;color:#0f172a;padding:24px 0;">
      <h2 style="color:#3426cf;margin:0 0 12px;">New support ticket</h2>
      <p>Leah escalated a support conversation to the team. The customer has been told you'll follow up by email.</p>

      <table cellpadding="0" cellspacing="0" style="margin:18px 0;font-size:14px;border-collapse:collapse;">
        <tr><td style="padding:6px 16px 6px 0;color:#475569;">Customer:</td><td style="padding:6px 0;"><strong>${escapeHtml(args.customerEmail)}</strong></td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#475569;">Ticket ID:</td><td style="padding:6px 0;font-family:'SFMono-Regular',Menlo,monospace;font-size:12px;">${escapeHtml(args.conversationId)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#475569;vertical-align:top;">Last message:</td><td style="padding:6px 0;">${escapeHtml(args.triggerMessage)}</td></tr>
      </table>

      <p style="margin:24px 0;">
        <a href="${ticketUrl}" style="display:inline-block;background:#3426cf;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Open in admin inbox</a>
        &nbsp;
        <a href="mailto:${escapeHtml(args.customerEmail)}" style="display:inline-block;background:#fff;color:#3426cf;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;border:1px solid #cbd5e1;">Reply by email</a>
      </p>

      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />

      <h3 style="margin:0 0 12px;color:#0f172a;">Recent conversation</h3>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;">
        ${transcriptHtml}
      </div>

      <p style="margin-top:24px;color:#64748b;font-size:12px;">
        Leah will keep helping the customer in the meantime — anything you tell them by email or in the admin inbox will reach them as a normal reply.
      </p>
    </div>
  `;

  const text =
    `New support ticket from ${args.customerEmail}.\n` +
    `Ticket ID: ${args.conversationId}\n` +
    `Last message: ${args.triggerMessage}\n\n` +
    `Reply by email or open in the admin inbox: ${ticketUrl}\n`;

  try {
    await sendEmail({
      to: [TEAM_INBOX],
      subject,
      html,
      text,
    });
  } catch (err) {
    console.error('[SUPPORT_ESCALATION] failed to send team email:', err);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
