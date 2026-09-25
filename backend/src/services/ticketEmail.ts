/**
 * Every email a ticket sends to a customer goes through here: staff replies,
 * the outbound "New email", the no-reply reminder and the closing notice.
 *
 * Kept in one place so the things that make a ticket email correct cannot
 * drift between callers — the reference in the subject (the inbound webhook
 * threads a reply by it), the RFC 5322 threading headers (so our message
 * lands in the customer's existing thread), the from-address (hello@, the
 * one address that can receive), and the signature.
 */
import { randomBytes } from 'crypto';
import { TicketEntryKind } from '@prisma/client';
import { prisma } from '../db.js';
import { sendEmail, SUPPORT_MAILGUN_DOMAIN } from '../utils/email.js';
import { ticketSubjectTag, stripTicketTag } from './ticketRef.js';

const OUTBOUND_MSGID_DOMAIN = process.env.MAILGUN_DOMAIN || 'receptionmate.co.uk';

/**
 * Who a ticket email comes FROM.
 *
 * Without this the send falls through to MAILGUN_FROM, which is
 * `noreply@receptionmate.co.uk` — a subdomain whose MX records point at a
 * Mailgun region the account does not use, so nothing sent there can ever be
 * received. The customer's reply would bounce and the thread this code builds
 * `In-Reply-To` for would silently dead-end.
 *
 * Replying as `hello@` is also what closes the loop: that address is on
 * Microsoft 365, whose rule copies it back to Mailgun's inbound webhook, so the
 * customer's reply threads onto this same ticket.
 */
export const SUPPORT_FROM = process.env.SUPPORT_FROM_EMAIL || 'hello@receptionmate.co.uk';

// ─── Signature ──────────────────────────────────────────────────────────────
// The banner from the company signature: logo left, tagline and contact
// details right, on brand blue (brand-600 in app/globals.css). The logo is the
// portal's own — white on transparent, which is exactly why it sits on the
// blue band and not on the white body. Hosted image, not an attachment: an
// inline attachment turns every reply into "1 attachment" in the customer's
// mail client and cannot be cached.

const LOGO_URL = 'https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png';
// White line icons on the brand blue, served by the portal (public/email/).
// Emoji glyphs were tried first: every client draws them at its own size and
// colour, so the rows never lined up. An image is the same everywhere.
const ICON_BASE = (process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk') + '/email';
const SIGNATURE_PHONE = '+44 333 370 1610';
const SIGNATURE_EMAIL = 'hello@receptionmate.co.uk';
const SIGNATURE_SITE = 'www.receptionmate.co.uk';
const BRAND_BLUE = '#3426cf';

export const SUPPORT_SIGNATURE_TEXT = [
  '— The ReceptionMate team',
  'The Future Of Front Desk Efficiency',
  `${SIGNATURE_PHONE} · ${SIGNATURE_EMAIL} · ${SIGNATURE_SITE}`,
].join('\n');

const contactRow = (icon: string, href: string, label: string): string => `
        <tr class="rm-sig-row">
          <td width="22" valign="middle" style="padding:0 0 6px;"><img src="${ICON_BASE}/icon-${icon}.png" alt="" width="15" height="15" style="display:block;width:15px;height:15px;border:0;" /></td>
          <td valign="middle" style="padding:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:17px;color:#ffffff;word-break:break-word;"><a href="${href}" style="color:#ffffff;text-decoration:none;">${label}</a></td>
        </tr>`;

// Two columns at every width — the logo on the left, the text taking the
// rest — because stacking the logo above the text on a phone read as a
// poster, not a signature. table-layout:fixed on the outer table stops the
// banner growing past the screen; the inner table lets the text column
// shrink. Base sizes are chosen so that, with no styles at all (clients that
// strip <style>), a 343px phone still fits the email address on one line;
// the media query then tightens everything further where it is honoured.
export const SUPPORT_SIGNATURE_HTML = `
<style>
  @media only screen and (max-width: 480px) {
    .rm-sig-pad { padding: 12px 10px !important; }
    .rm-sig-logo-box { width: 98px !important; padding-right: 8px !important; }
    .rm-sig-logo { width: 88px !important; max-width: 88px !important; }
    .rm-sig-tag { font-size: 15px !important; line-height: 19px !important; padding-bottom: 7px !important; }
    .rm-sig-row td { font-size: 12.5px !important; line-height: 16px !important; padding-bottom: 4px !important; }
    .rm-sig-row img { width: 13px !important; height: 13px !important; }
  }
</style>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin-top:28px;table-layout:fixed;border-collapse:separate;border-radius:10px;overflow:hidden;background:${BRAND_BLUE};">
  <tr>
    <td class="rm-sig-pad" style="padding:16px 14px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td class="rm-sig-logo-box" width="115" valign="middle" style="width:115px;padding:0 10px 0 0;text-align:center;">
            <img class="rm-sig-logo" src="${LOGO_URL}" alt="ReceptionMate" width="105" style="display:inline-block;width:105px;max-width:105px;height:auto;border:0;" />
          </td>
          <td valign="middle" style="text-align:left;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr><td class="rm-sig-tag" colspan="2" style="padding:0 0 9px;font-family:Arial,Helvetica,sans-serif;font-size:17px;line-height:22px;font-weight:bold;color:#ffffff;">The Future Of Front Desk Efficiency</td></tr>${contactRow('phone', `tel:${SIGNATURE_PHONE.replace(/\s+/g, '')}`, SIGNATURE_PHONE)}${contactRow('mail', `mailto:${SIGNATURE_EMAIL}`, SIGNATURE_EMAIL)}${contactRow('globe', `https://${SIGNATURE_SITE}`, SIGNATURE_SITE)}
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`.trim();

/** Append the signature to both renderings of an email body. */
export function withSupportSignature(text: string, html: string): { text: string; html: string } {
  return {
    text: `${text.trimEnd()}\n\n${SUPPORT_SIGNATURE_TEXT}`,
    html: `${html}\n${SUPPORT_SIGNATURE_HTML}`,
  };
}

// ─── Body rendering ─────────────────────────────────────────────────────────

/** Plain text → minimal HTML: one <p> per paragraph, line breaks preserved. */
export const textToHtml = (text: string): string => {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#1f2937;">${escape(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
};

// ─── Threading (spec §7) ────────────────────────────────────────────────────
// A stored, deterministic Message-Id lets a customer's reply come back with
// In-Reply-To pointing at us — the inbound webhook then threads it to the
// correct ticket by looking up TicketEntry.outboundMessageId.

export const generateOutboundMessageId = (ticketNumber: number): string => {
  const rand = randomBytes(6).toString('hex');
  return `<rm-t${ticketNumber}.${Date.now()}.${rand}@${OUTBOUND_MSGID_DOMAIN}>`;
};

/** In-Reply-To + References from the latest inbound entry on this ticket, so
 *  our message lands in the customer's original thread (RFC 5322 §3.6.4). */
export async function buildThreadingHeaders(
  ticketId: string,
  outboundMessageId: string,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Message-Id': outboundMessageId };

  const lastInbound = await prisma.ticketEntry.findFirst({
    where: { ticketId, authorContactId: { not: null }, kind: TicketEntryKind.public_reply },
    orderBy: { createdAt: 'desc' },
    select: { meta: true },
  });
  const meta =
    lastInbound?.meta && typeof lastInbound.meta === 'object' && !Array.isArray(lastInbound.meta)
      ? (lastInbound.meta as Record<string, unknown>)
      : null;
  const bracket = (id: string) => (id.startsWith('<') ? id : `<${id}>`);
  const inboundId = meta && typeof meta.inboundMessageId === 'string' && meta.inboundMessageId ? meta.inboundMessageId : null;
  const inboundInReplyTo = meta && typeof meta.inReplyTo === 'string' && meta.inReplyTo ? meta.inReplyTo : null;

  if (inboundId) {
    headers['In-Reply-To'] = bracket(inboundId);
    headers.References = [inboundInReplyTo ? bracket(inboundInReplyTo) : '', bracket(inboundId)].filter(Boolean).join(' ');
  }
  return headers;
}

// ─── Send ───────────────────────────────────────────────────────────────────

export interface TicketEmailResult {
  sendOk: boolean;
  outboundMessageId: string;
  threadingHeaders: Record<string, string>;
  subject: string;
}

/**
 * Send `body` to the customer on a ticket: tagged subject, threading headers,
 * from hello@, signature appended. Records nothing — the caller decides what
 * the entry looks like (a staff reply, an automatic notice, a retry).
 */
export async function sendTicketEmail(args: {
  ticketId: string;
  ticketNumber: number;
  title: string;
  to: string;
  body: string;
  /** Copied in. Their reply-all threads back onto this ticket through the
   *  subject tag like any other, so a colleague or a third party stays part of
   *  the same conversation rather than starting a second one. */
  cc?: string[];
}): Promise<TicketEmailResult> {
  const outboundMessageId = generateOutboundMessageId(args.ticketNumber);
  const threadingHeaders = await buildThreadingHeaders(args.ticketId, outboundMessageId);

  // Subject always carries the reference so a reply threads back via the
  // subject-tag rule. Strip any prior tag from the title so we do not double up.
  const cleanTitle = stripTicketTag(args.title) || 'Your ticket';
  const subject = `${ticketSubjectTag(args.ticketNumber)} ${cleanTitle}`.slice(0, 300);

  const { text, html } = withSupportSignature(args.body, textToHtml(args.body));
  const sendOk = await sendEmail({
    to: [args.to],
    ...(args.cc?.length ? { cc: args.cc } : {}),
    from: SUPPORT_FROM,
    // Through the support domain, so the return path never reads "noreply".
    domain: SUPPORT_MAILGUN_DOMAIN,
    subject,
    text,
    html,
    headers: threadingHeaders,
  });
  return { sendOk, outboundMessageId, threadingHeaders, subject };
}
