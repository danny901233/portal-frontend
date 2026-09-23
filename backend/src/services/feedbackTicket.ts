/**
 * Thumbs-down in the portal raises a support ticket.
 *
 * Negative feedback used to fire a Discord alert and an email to the team, which
 * meant it was something we watched rather than something we worked: no owner,
 * no status, no record of whether anyone did anything, and nothing to tell the
 * person who bothered to leave it. It also died in the same inbox everything else
 * used to die in.
 *
 * Now it becomes a ticket like any other, so it sits in the same queue, gets
 * assigned, and closes when it is actually dealt with. The email to the team goes
 * away — the ticket IS the notification, and it pushes to our phones.
 *
 * The person rating is a portal user (a garage's staff), not the end customer who
 * rang in, so the ticket's contact is them and the acknowledgement goes to them.
 *
 * The channel is recorded as `email` rather than `portal_chat`, deliberately.
 * Channel here decides how staff can REPLY, and the reply path only sends on the
 * email channel — filing it as portal_chat would produce a ticket whose replies
 * are silently never delivered. They came in through the portal but the
 * conversation, if there is one, happens by email.
 */
import { TicketChannel, TicketCategory, TicketEntryKind, TicketPriority } from '@prisma/client';
import { prisma } from '../db.js';
import { sendEmail, SUPPORT_REPLY_TO, SUPPORT_MAILGUN_DOMAIN } from '../utils/email.js';
import { ticketSubjectTag } from './ticketRef.js';
import { notifyReceptionMateStaff } from '../utils/push.js';

export interface FeedbackTicketArgs {
  /** Portal user who left the rating. */
  userEmail: string;
  userId?: string | null;
  /** Garage the call/conversation belonged to. */
  garageId?: string | null;
  garageName: string;
  /** "call" or the chat platform label ("WhatsApp", "Web chat", ...). */
  source: string;
  /** Deep link back to the thing rated. */
  link?: string | null;
  reasons: string[];
  notes?: string | null;
}

/** What the rater is told. Deliberately sets the expectation that silence is a
 *  normal outcome — most feedback is acted on without a conversation, and
 *  promising a reply we will not send is worse than saying so plainly. */
function acknowledgementBody(): { text: string; html: string } {
  const lines = [
    'Thanks for the feedback — it has reached our team.',
    '',
    'Feedback like this is genuinely important to us, and we read all of it. You may not get a reply to this message, but where we can act on it, we do.',
    '',
    'If we need any more detail to sort it out, we will be in touch.',
    '',
    '— The ReceptionMate team',
  ];
  return {
    text: lines.join('\n'),
    html:
      '<p>Thanks for the feedback — it has reached our team.</p>' +
      '<p>Feedback like this is genuinely important to us, and we read all of it. ' +
      'You may not get a reply to this message, but where we can act on it, we do.</p>' +
      '<p>If we need any more detail to sort it out, we will be in touch.</p>' +
      '<p>— The ReceptionMate team</p>',
  };
}

/**
 * Create the ticket, tell the team, acknowledge the rater.
 *
 * Best-effort throughout: the rating itself is already saved by the time this
 * runs, and losing a ticket is better than failing the thumbs-down the user just
 * pressed. Every step is caught.
 */
export async function raiseNegativeFeedbackTicket(args: FeedbackTicketArgs): Promise<void> {
  try {
    const email = args.userEmail.trim().toLowerCase();
    if (!email) return;

    const contact = await prisma.contact.upsert({
      where: { email },
      update: {},
      create: { email, userId: args.userId ?? undefined, garageId: args.garageId ?? undefined },
    });

    const title = `Thumbs down — ${args.source} at ${args.garageName}`.slice(0, 300);

    const detail = [
      `${args.source} at ${args.garageName} was rated thumbs down by ${email}.`,
      args.reasons.length ? `\nReasons: ${args.reasons.join(', ')}` : '',
      args.notes ? `\nNotes: ${args.notes}` : '',
      args.link ? `\n${args.link}` : '',
    ].filter(Boolean).join('');

    const ticket = await prisma.ticket.create({
      data: {
        title,
        channel: TicketChannel.email,
        // Somebody using the product told us it got something wrong. That is what
        // this category is for, and it keeps feedback next to the bug reports
        // that arrive by email.
        category: TicketCategory.agent_bug,
        priority: TicketPriority.normal,
        contactId: contact.id,
        garageId: args.garageId ?? undefined,
        entries: {
          create: {
            kind: TicketEntryKind.public_reply,
            authorContactId: contact.id,
            body: detail,
          },
        },
      },
    });

    void notifyReceptionMateStaff({
      title: 'Thumbs down',
      subtitle: args.garageName,
      body: args.notes?.trim() || args.reasons.join(', ') || `${args.source} rated negatively`,
      data: { type: 'ticket', ticketId: ticket.id, ticketNumber: ticket.number },
    }).catch((err) => console.error('[FEEDBACK_TICKET] push failed:', err));

    const { text, html } = acknowledgementBody();
    const sent = await sendEmail({
      to: [email],
      from: process.env.SUPPORT_FROM_EMAIL || 'hello@receptionmate.co.uk',
      replyTo: SUPPORT_REPLY_TO,
      domain: SUPPORT_MAILGUN_DOMAIN,
      subject: `${ticketSubjectTag(ticket.number)} Thanks for your feedback`,
      text,
      html,
      template: 'feedback_ack',
      garageId: args.garageId ?? undefined,
    });

    if (sent) {
      await prisma.ticketEntry.create({
        data: {
          ticketId: ticket.id,
          kind: TicketEntryKind.auto_ack,
          body: text,
        },
      });
    }

    console.log(`[FEEDBACK_TICKET] ticket #${ticket.number} raised from ${args.source} feedback by ${email}`);
  } catch (err) {
    console.error('[FEEDBACK_TICKET] failed to raise ticket:', err);
  }
}
