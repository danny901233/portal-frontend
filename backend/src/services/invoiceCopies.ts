// Send a customer copies of their own invoices.
//
// This exists because there was no way to do it. The only sender that attached invoice PDFs was
// the arrears chaser (invoiceChase.ts), and that email is a payment demand — pointing it at a
// customer whose invoices are all paid would be worse than sending nothing. So staff either
// downloaded the PDFs and forwarded them by hand, or the customer went without.
//
// Deliberately neutral: it states no opinion about whether anything is owed, and it does not
// offer a payment link. It is a copy of a record the customer is entitled to, nothing more.

import { prisma } from '../db.js';
import { sendEmail, brandedEmailShell, type EmailAttachment } from '../utils/email.js';
import { generateInvoicePdf } from './invoicePdf.js';

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

export interface InvoiceCopiesResult {
  sent: boolean;
  to?: string;
  invoiceCount: number;
  /** Invoices whose PDF would not render — reported, never silently dropped. */
  failedInvoiceIds: string[];
  reason?: string;
}

/**
 * Email every invoice we hold for a garage to an address, as one message with one PDF attached
 * per invoice.
 *
 * One email rather than one per invoice: seven separate messages reads as a billing incident and
 * buries the customer's inbox for no gain.
 *
 * `to` is required and passed in by the caller rather than resolved from the garage. Picking a
 * billing contact automatically is how a £1,855 demand once landed in a branch counter mailbox
 * (see resolveBillingContact in invoiceChase.ts) — for a manual staff action, the person pressing
 * the button should see and own the address.
 */
export async function sendInvoiceCopies(params: {
  garageId: string;
  to: string;
  /** Who asked for this, for the audit row. */
  requestedByUserId?: string | null;
}): Promise<InvoiceCopiesResult> {
  const { garageId, to } = params;

  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { id: true, name: true, businessId: true },
  });
  if (!garage) {
    return { sent: false, invoiceCount: 0, failedInvoiceIds: [], reason: 'garage not found' };
  }

  // Cancelled invoices are excluded: a cancelled invoice is not a document the customer owes
  // anything against, and sending one invites a question we created ourselves.
  const invoices = await prisma.invoice.findMany({
    where: { garageId, status: { not: 'cancelled' } },
    orderBy: { periodStart: 'asc' },
    select: { id: true, periodStart: true, periodEnd: true, total: true, status: true },
  });

  if (invoices.length === 0) {
    return { sent: false, invoiceCount: 0, failedInvoiceIds: [], reason: 'no invoices to send' };
  }

  const attachments: EmailAttachment[] = [];
  const failedInvoiceIds: string[] = [];
  for (const inv of invoices) {
    try {
      const pdf = await generateInvoicePdf(inv.id);
      attachments.push({
        filename: pdfName(garage.name, inv.periodStart),
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

  if (attachments.length === 0) {
    return {
      sent: false,
      invoiceCount: invoices.length,
      failedInvoiceIds,
      reason: 'no invoice PDF could be rendered',
    };
  }

  const rows = invoices
    .filter((inv) => !failedInvoiceIds.includes(inv.id))
    .map(
      (inv) => `
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #eef0f7; font-size: 14px; color: #3c4260;">
          ${prettyPeriod(inv.periodStart, inv.periodEnd)}
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
          As requested, here are copies of the ${countWord} we hold for
          <strong>${garage.name}</strong>. Each one is attached to this email as a PDF.
        </p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 24px 0;">
          ${rows}
        </table>
        <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #3c4260;">
          You can also view and download these any time from the Billing page in your
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
    `As requested, here are copies of the ${countWord} we hold for ${garage.name}.`,
    `Each one is attached to this email as a PDF.`,
    ``,
    ...invoices
      .filter((inv) => !failedInvoiceIds.includes(inv.id))
      .map((inv) => `  ${prettyPeriod(inv.periodStart, inv.periodEnd)}  ${money(inv.total)}`),
    ``,
    `You can also view and download these any time from the Billing page in your ReceptionMate portal.`,
    ``,
    `If anything here doesn't look right, just reply to this email and we'll pick it up.`,
  ].join('\n');

  const sent = await sendEmail({
    to: [to],
    replyTo: 'hello@receptionmate.co.uk',
    subject: `Your ReceptionMate ${countWord} — ${garage.name}`,
    html,
    text,
    attachments,
    template: 'invoice_copies',
    garageId: garage.id,
    businessId: garage.businessId,
    userId: params.requestedByUserId ?? null,
  });

  return {
    sent,
    to,
    invoiceCount: attachments.length,
    failedInvoiceIds,
    reason: sent ? undefined : 'send failed',
  };
}
