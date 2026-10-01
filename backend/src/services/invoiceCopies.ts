// Email someone copies of invoices.
//
// This exists because there was no way to do it. The only sender that attached invoice PDFs was
// the arrears chaser (invoiceChase.ts), and that email is a payment demand — pointing it at a
// customer whose invoices are all paid would be worse than sending nothing. So staff either
// downloaded the PDFs and forwarded them by hand, or the customer went without.
//
// Deliberately neutral: it states no opinion about whether anything is owed, and it does not
// offer a payment link. It is a copy of a record the customer is entitled to, nothing more.
//
// This function does NOT decide who may read an invoice. It takes an explicit list of invoice ids
// and an explicit list of recipients, both already authorised by the caller. Two callers rely on
// that split: a staff action in admin.ts, and a self-serve action on the customer's own billing
// page, which may only ever pass invoices the signed-in user manages.

import { prisma } from '../db.js';
import { sendEmail, brandedEmailShell, type EmailAttachment } from '../utils/email.js';
import {
  generateInvoicePdf,
  generateCombinedInvoicePdf,
  combinedInvoiceNumber,
} from './invoicePdf.js';

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const money = (pence: number) => GBP.format(pence / 100);

const prettyPeriod = (start: Date, end: Date) => {
  const f = (d: Date) =>
    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${f(start)} – ${f(end)}`;
};

/** A filename the customer can actually file: branch and period, not a cuid. */
const pdfName = (garageName: string, periodStart: Date) => {
  const branch = garageName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const ym = `${periodStart.getFullYear()}-${String(periodStart.getMonth() + 1).padStart(2, '0')}`;
  return `ReceptionMate-Invoice-${branch}-${ym}.pdf`;
};

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * How many of these one person may send per hour.
 *
 * Counted from the email audit log rather than memory, so a backend restart cannot reset it.
 * The limit is about our sending reputation: every one of these carries PDF attachments from
 * our domain, and the optional second recipient means a customer can aim it somewhere we have
 * no relationship with.
 */
export const HOURLY_SEND_LIMIT = 10;

export async function invoiceCopiesSentInLastHour(userId: string): Promise<number> {
  return prisma.emailLog.count({
    where: {
      userId,
      template: 'invoice_copies',
      sentAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
    },
  });
}

export interface InvoiceCopiesResult {
  sent: boolean;
  to?: string[];
  invoiceCount: number;
  /** Invoices whose PDF would not render — reported, never silently dropped. */
  failedInvoiceIds: string[];
  reason?: string;
}

/**
 * Email the given invoices to the given recipients, as one message with one PDF per invoice.
 *
 * One email rather than one per invoice: seven separate messages reads as a billing incident and
 * buries the reader's inbox for no gain.
 */
export interface CombinedSelection {
  businessId: string;
  periodStart: Date;
  /** What the customer sees the bill as, for the covering email's list. */
  label: string;
  total: number;
}

export async function sendInvoiceCopies(params: {
  /** Already authorised by the caller. */
  invoiceIds: string[];
  /**
   * Combined invoices the customer picked. A business on combined invoicing is billed as one, so
   * the document they know is the combined one — sending its branch rows instead would hand them
   * paperwork that matches neither their bank statement nor the PDF they can download.
   */
  combined?: CombinedSelection[];
  /** Already authorised by the caller. At least one. */
  to: string[];
  requestedByUserId?: string | null;
}): Promise<InvoiceCopiesResult> {
  const recipients = params.to.map((t) => t.trim()).filter((t) => EMAIL_RE.test(t));
  if (recipients.length === 0) {
    return { sent: false, invoiceCount: 0, failedInvoiceIds: [], reason: 'no valid recipient' };
  }
  const combinedPicks = params.combined ?? [];
  if (params.invoiceIds.length === 0 && combinedPicks.length === 0) {
    return { sent: false, invoiceCount: 0, failedInvoiceIds: [], reason: 'no invoices selected' };
  }

  const invoices = await prisma.invoice.findMany({
    where: { id: { in: params.invoiceIds } },
    orderBy: { periodStart: 'asc' },
    select: {
      id: true,
      periodStart: true,
      periodEnd: true,
      total: true,
      status: true,
      garage: { select: { id: true, name: true, businessId: true } },
    },
  });

  if (invoices.length === 0 && combinedPicks.length === 0) {
    return { sent: false, invoiceCount: 0, failedInvoiceIds: [], reason: 'no invoices found' };
  }

  const garageNames = [...new Set(invoices.map((i) => i.garage.name))];
  if (garageNames.length === 0 && combinedPicks.length > 0) garageNames.push('your account');
  // One branch names itself; several are summarised, because putting six branch names in a
  // subject line makes it unreadable in every mail client.
  const subjectScope = garageNames.length === 1 ? garageNames[0] : `${garageNames.length} branches`;

  const attachments: EmailAttachment[] = [];
  const failedInvoiceIds: string[] = [];
  for (const inv of invoices) {
    try {
      const pdf = await generateInvoicePdf(inv.id);
      attachments.push({
        filename: pdfName(inv.garage.name, inv.periodStart),
        content: pdf,
        contentType: 'application/pdf',
      });
    } catch (err) {
      // Best effort per invoice, but the caller is told which ones are missing so nobody
      // believes a partial send was a complete one.
      console.error(`[INVOICE_COPIES] could not render PDF for invoice ${inv.id}:`, err);
      failedInvoiceIds.push(inv.id);
    }
  }

  for (const pick of combinedPicks) {
    try {
      const pdf = await generateCombinedInvoicePdf(pick.businessId, pick.periodStart);
      attachments.push({
        filename: `${combinedInvoiceNumber(pick.businessId, pick.periodStart)}.pdf`,
        content: pdf,
        contentType: 'application/pdf',
      });
    } catch (err) {
      console.error(`[INVOICE_COPIES] could not render combined PDF for ${pick.businessId}:`, err);
      failedInvoiceIds.push(`${pick.businessId}:${pick.periodStart.toISOString()}`);
    }
  }

  if (attachments.length === 0) {
    return {
      sent: false,
      invoiceCount: invoices.length + combinedPicks.length,
      failedInvoiceIds,
      reason: 'no invoice PDF could be rendered',
    };
  }

  const included = invoices.filter((inv) => !failedInvoiceIds.includes(inv.id));
  const showBranch = garageNames.length > 1;

  const combinedRows = combinedPicks
    .map(
      (pick) => `
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #eef0f7; font-size: 14px; color: #3c4260;">${pick.label}</td>
        <td style="padding: 10px 0; border-bottom: 1px solid #eef0f7; font-size: 14px; color: #3c4260; text-align: right; white-space: nowrap;">${money(pick.total)}</td>
      </tr>`,
    )
    .join('');

  const rows = combinedRows + included
    .map(
      (inv) => `
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #eef0f7; font-size: 14px; color: #3c4260;">
          ${prettyPeriod(inv.periodStart, inv.periodEnd)}
          ${showBranch ? `<br/><span style="font-size: 12px; color: #8b90b0;">${inv.garage.name}</span>` : ''}
        </td>
        <td style="padding: 10px 0; border-bottom: 1px solid #eef0f7; font-size: 14px; color: #3c4260; text-align: right; white-space: nowrap;">
          ${money(inv.total)}
        </td>
      </tr>`,
    )
    .join('');

  const countWord = attachments.length === 1 ? 'invoice' : 'invoices';
  const html = brandedEmailShell(`
    <tr>
      <td style="padding: 32px;">
        <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #1b1f3b;">
          Hi,
        </p>
        <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #3c4260;">
          Here ${attachments.length === 1 ? 'is a copy of the invoice' : 'are copies of the invoices'}
          requested for <strong>${subjectScope}</strong>, attached to this email as
          ${attachments.length === 1 ? 'a PDF' : 'PDFs'}.
        </p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 24px 0;">
          ${rows}
        </table>
        <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #3c4260;">
          These can be viewed and downloaded any time from the Billing page in the
          ReceptionMate portal.
        </p>
        <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #3c4260;">
          If anything here doesn't look right, just reply to this email and we'll pick it up.
        </p>
      </td>
    </tr>
  `);

  const text = [
    `Hi,`,
    ``,
    `Here ${attachments.length === 1 ? 'is a copy of the invoice' : 'are copies of the invoices'} requested for ${subjectScope}.`,
    `${attachments.length === 1 ? 'It is' : 'They are'} attached to this email.`,
    ``,
    ...combinedPicks.map((pick) => `  ${pick.label}  ${money(pick.total)}`),
    ...included.map(
      (inv) =>
        `  ${prettyPeriod(inv.periodStart, inv.periodEnd)}  ${money(inv.total)}` +
        (showBranch ? `  (${inv.garage.name})` : ''),
    ),
    ``,
    `These can be viewed and downloaded any time from the Billing page in the ReceptionMate portal.`,
    ``,
    `If anything here doesn't look right, just reply to this email and we'll pick it up.`,
  ].join('\n');

  const sent = await sendEmail({
    to: recipients,
    replyTo: 'hello@receptionmate.co.uk',
    subject: `Your ReceptionMate ${countWord} — ${subjectScope}`,
    html,
    text,
    attachments,
    template: 'invoice_copies',
    garageId: invoices.length > 0 && garageNames.length === 1 ? invoices[0].garage.id : null,
    businessId: invoices[0]?.garage.businessId ?? combinedPicks[0]?.businessId ?? null,
    userId: params.requestedByUserId ?? null,
  });

  return {
    sent,
    to: recipients,
    invoiceCount: attachments.length,
    failedInvoiceIds,
    reason: sent ? undefined : 'send failed',
  };
}
