import PDFDocument from 'pdfkit';
import { prisma } from '../db.js';
import { sendEmail } from '../utils/email.js';
import { createSetupFeeCheckoutSession } from './stripe.js';
import { stripeConfigured } from './stripe.js';
import {
  BANK,
  COMPANY_FOOTER,
  RM_LOGO_URL,
  SUPPORT_EMAIL,
  DEFAULT_VAT_RATE,
} from './companyDetails.js';

/**
 * One-off setup-fee invoice, raised when an agreement with a setup fee is signed.
 *
 * The agreement template already tells the customer "a setup fee of X is due upon signing" —
 * this is the thing that actually collects it. Two ways to pay, on the same invoice:
 *   - bank transfer, quoting the invoice number as the reference
 *   - card, via a Stripe Checkout link (mode:'payment' — a single charge, not a subscription)
 *
 * Self-serve signups are untouched: they hardcode setupFeeGbp: 0, and nothing here runs at 0.
 */

const BRAND = '#3426cf';
const BRAND_50 = '#eef0fe';
const BRAND_100 = '#dde0fd';
const INK_900 = '#0f172a';
const INK_700 = '#334155';
const INK_500 = '#64748b';
const INK_400 = '#94a3b8';
const INK_200 = '#e2e8f0';
const INK_50 = '#f8fafc';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const gbp = (pence: number) => `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

// No terms: the agreement says the setup fee is "due upon signing", so the invoice must say the
// same. Issue date and due date are the same day.

export interface SetupFeeInvoiceData {
  invoiceId: string;
  invoiceNumber: string;
  clientName: string;
  garageName: string;
  customerEmail: string;
  netPence: number;
  vatPence: number;
  grossPence: number;
  vatRate: number;
  issued: Date;
  due: Date;
  payUrl: string | null; // null when Stripe isn't configured — bank transfer still works
}

/**
 * Next invoice number in the INV-SETUP-nnnn sequence.
 *
 * Deliberately NOT the In'n'out scheme (INV-INO-YYMM): that's per-month, unique only because
 * there's one In'n'out invoice a month. Setup fees can be raised several times a day, so they
 * need a real sequence. Derived from the highest existing number rather than a counter table;
 * the unique index on invoiceNumber is the actual guard against collisions.
 */
async function nextInvoiceNumber(): Promise<string> {
  const last = await prisma.invoice.findFirst({
    where: { kind: 'setup_fee', invoiceNumber: { startsWith: 'INV-SETUP-' } },
    orderBy: { invoiceNumber: 'desc' },
    select: { invoiceNumber: true },
  });
  const n = last?.invoiceNumber ? parseInt(last.invoiceNumber.replace('INV-SETUP-', ''), 10) : 0;
  return `INV-SETUP-${String((Number.isFinite(n) ? n : 0) + 1).padStart(4, '0')}`;
}

/**
 * Create (or return) the setup-fee invoice for an agreement.
 *
 * Idempotent on agreementId: signing is retryable and the send path is fire-and-forget, so this
 * must never raise a second invoice for the same fee. Returns null when there's no fee to bill.
 */
export async function createSetupFeeInvoice(agreementId: string): Promise<SetupFeeInvoiceData | null> {
  const agreement = await prisma.agreement.findUnique({
    where: { id: agreementId },
    select: {
      id: true,
      clientName: true,
      setupFeeGbp: true,
      businessId: true,
      signedAt: true,
      // Where the agreement was actually sent. The signer is often not the portal account
      // holder, and the invoice should follow the person who signed it.
      sentToEmail: true,
      user: { select: { id: true, email: true } },
    },
  });
  if (!agreement) return null;
  if (!agreement.setupFeeGbp || agreement.setupFeeGbp <= 0) return null; // nothing to bill

  // Bill the business's first garage — the fee is per-deal, not per-branch.
  const garage = await prisma.garage.findFirst({
    where: { businessId: agreement.businessId ?? undefined },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, businessId: true, vatRate: true, stripeCustomerId: true },
  });
  if (!garage) {
    console.warn(`[SETUP-FEE] agreement ${agreementId} has no garage — cannot raise an invoice`);
    return null;
  }

  const existing = await prisma.invoice.findFirst({
    where: { kind: 'setup_fee', agreementId },
    select: { id: true, invoiceNumber: true, total: true, subtotal: true, vatAmount: true, vatRate: true, createdAt: true, stripeCheckoutSessionId: true },
  });

  // Follow the agreement to wherever it was sent; fall back to the account holder for
  // agreements that predate recipient overrides.
  const recipientEmail = agreement.sentToEmail || agreement.user?.email || '';

  const vatRate = garage.vatRate ?? DEFAULT_VAT_RATE;
  const netPence = Math.round(agreement.setupFeeGbp * 100);
  const vatPence = Math.round(netPence * vatRate);
  const grossPence = netPence + vatPence;
  const issued = existing?.createdAt ?? agreement.signedAt ?? new Date();
  const due = issued; // due on signing, per the agreement

  let invoiceId: string;
  let invoiceNumber: string;

  if (existing) {
    invoiceId = existing.id;
    invoiceNumber = existing.invoiceNumber ?? (await nextInvoiceNumber());
    console.log(`[SETUP-FEE] reusing existing invoice ${invoiceNumber} for agreement ${agreementId}`);
  } else {
    invoiceNumber = await nextInvoiceNumber();
    const inv = await prisma.invoice.create({
      data: {
        kind: 'setup_fee',
        agreementId,
        invoiceNumber,
        garageId: garage.id,
        businessId: garage.businessId,
        userId: agreement.user?.id ?? null,
        // A setup fee has no billing period. Both dates are the issue date rather than null,
        // because periodStart/periodEnd are non-null columns read by 45 call sites.
        periodStart: issued,
        periodEnd: issued,
        subscriptionAmount: 0, // not a subscription charge — the fee is the whole invoice
        minutesAmount: 0,
        smsAmount: 0,
        messagingSubscriptionAmount: 0,
        subtotal: netPence,
        vatAmount: vatPence,
        total: grossPence,
        subscriptionCostGbp: 0,
        costPerMinuteGbp: 0,
        vatRate,
        status: 'pending',
      },
      select: { id: true },
    });
    invoiceId = inv.id;
    console.log(`[SETUP-FEE] raised ${invoiceNumber} ${gbp(grossPence)} for ${agreement.clientName}`);
  }

  // Card link. Best-effort: if Stripe is down or unconfigured the invoice is still valid and
  // payable by transfer, so this must not throw the whole thing away.
  let payUrl: string | null = null;
  if (stripeConfigured()) {
    try {
      const session = await createSetupFeeCheckoutSession({
        invoiceId,
        invoiceNumber,
        agreementId,
        garageId: garage.id,
        garageName: garage.name,
        customerEmail: recipientEmail,
        amountPence: grossPence,
        stripeCustomerId: garage.stripeCustomerId,
      });
      payUrl = session.url;
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { stripeCheckoutSessionId: session.id },
      });
    } catch (e) {
      console.error(`[SETUP-FEE] Stripe session for ${invoiceNumber} failed — invoice still payable by transfer:`, e);
    }
  }

  return {
    invoiceId,
    invoiceNumber,
    clientName: agreement.clientName,
    garageName: garage.name,
    customerEmail: recipientEmail,
    netPence,
    vatPence,
    grossPence,
    vatRate,
    issued,
    due,
    payUrl,
  };
}

async function fetchLogo(): Promise<Buffer | null> {
  try {
    const r = await fetch(RM_LOGO_URL);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

/** Render the setup-fee invoice PDF. Layout follows the In'n'out invoice so they look like a set. */
export async function renderSetupFeeInvoicePdf(d: SetupFeeInvoiceData): Promise<Buffer> {
  const logo = await fetchLogo();
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const L = 44;
      const R = 595.28 - 44;
      let y = 44;

      // --- header ---
      const boxH = 74;
      doc.roundedRect(L, y, 150, boxH, 14).fill(BRAND);
      if (logo) {
        try { doc.image(logo, L + 22, y + 20, { height: 34 }); } catch { /* text fallback below */ }
      } else {
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19).text('ReceptionMate', L + 18, y + 27);
      }
      doc.fillColor(INK_900).font('Helvetica-Bold').fontSize(28).text('Invoice', R - 200, y + 8, { width: 200, align: 'right' });
      doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(12).text(d.invoiceNumber, R - 200, y + 44, { width: 200, align: 'right' });
      y += boxH + 26;

      // --- billed to / details ---
      doc.fillColor(INK_400).font('Helvetica-Bold').fontSize(8).text('BILLED TO', L, y);
      doc.fillColor(INK_900).font('Helvetica-Bold').fontSize(12).text(d.clientName, L, y + 14, { width: 260 });
      doc.fillColor(INK_700).font('Helvetica').fontSize(10).text(d.customerEmail, L, y + 30, { width: 260 });

      const dX = 330, dValX = R - 130;
      const rows: [string, string][] = [
        ['Issued', fmtDate(d.issued)],
        ['Due', 'On signing'],
      ];
      doc.fillColor(INK_400).font('Helvetica-Bold').fontSize(8).text('INVOICE DETAILS', dX, y);
      let dy = y + 14;
      for (const [k, v] of rows) {
        doc.fillColor(INK_500).font('Helvetica').fontSize(10).text(k, dX, dy);
        doc.fillColor(INK_900).font('Helvetica-Bold').fontSize(10).text(v, dValX, dy, { width: 130, align: 'right' });
        dy += 15;
      }
      y = Math.max(y + 56, dy) + 12;

      // --- line item ---
      const colAmt = R - 70;
      doc.rect(L, y, R - L, 24).fill(INK_50);
      doc.fillColor(INK_500).font('Helvetica-Bold').fontSize(8);
      doc.text('DESCRIPTION', L + 10, y + 8);
      doc.text('AMOUNT', colAmt - 20, y + 8, { width: 90, align: 'right' });
      y += 30;

      doc.fillColor(INK_700).font('Helvetica').fontSize(10).text('One-off setup fee', L + 10, y);
      doc.fillColor(INK_900).text(gbp(d.netPence), colAmt - 20, y, { width: 90, align: 'right' });
      y += 15;
      doc.fillColor(INK_500).font('Helvetica').fontSize(9).text(`Integration, agent build and configuration — ${d.garageName}`, L + 10, y, { width: 320 });
      y += 18;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(INK_200).stroke();

      // --- totals ---
      y += 14;
      const tLabelX = R - 250, tValX = R - 90;
      doc.fillColor(INK_700).font('Helvetica').fontSize(11).text('Subtotal', tLabelX, y, { width: 130, align: 'right' });
      doc.fillColor(INK_900).text(gbp(d.netPence), tValX, y, { width: 90, align: 'right' });
      y += 20;
      doc.fillColor(INK_700).text(`VAT (${Math.round(d.vatRate * 100)}%)`, tLabelX, y, { width: 130, align: 'right' });
      doc.fillColor(INK_900).text(gbp(d.vatPence), tValX, y, { width: 90, align: 'right' });
      y += 24;
      doc.roundedRect(R - 250, y, 250, 44, 12).fill(BRAND);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text('TOTAL DUE', R - 240, y + 16);
      doc.fontSize(18).text(gbp(d.grossPence), R - 160, y + 12, { width: 150, align: 'right' });
      y += 44 + 22;

      // --- how to pay: card + transfer, side by side ---
      const panelH = d.payUrl ? 104 : 66;
      doc.roundedRect(L, y, R - L, panelH, 14).fillAndStroke(BRAND_50, BRAND_100);
      doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(8).text('HOW TO PAY', L + 18, y + 14);

      const pays: [string, string][] = [
        ['Account name', BANK.name],
        ['Sort code', BANK.sort],
        ['Account number', BANK.account],
        ['Reference', d.invoiceNumber],
      ];
      const cellW = (R - L - 36) / 4;
      pays.forEach(([k, v], i) => {
        const cx = L + 18 + i * cellW;
        doc.fillColor(INK_500).font('Helvetica').fontSize(9).text(k, cx, y + 32);
        doc.fillColor(INK_900).font('Helvetica-Bold').fontSize(11).text(v, cx, y + 45);
      });

      if (d.payUrl) {
        doc.moveTo(L + 18, y + 68).lineTo(R - 18, y + 68).lineWidth(0.5).strokeColor(BRAND_100).stroke();
        doc.fillColor(INK_500).font('Helvetica').fontSize(9).text('Prefer to pay by card?', L + 18, y + 78);
        doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10)
          .text('Pay now by card', L + 150, y + 77, { link: d.payUrl, underline: true });
      }
      y += panelH + 24;

      // --- footer ---
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(INK_200).stroke();
      doc.fillColor(INK_400).font('Helvetica').fontSize(8.5).text(COMPANY_FOOTER, L, y + 12, { width: R - L, align: 'center' });
      doc.fillColor(INK_500).fontSize(8.5).text(`Questions? ${SUPPORT_EMAIL}`, L, y + 26, { width: R - L, align: 'center' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Render + email an already-raised setup-fee invoice.
 *
 * Split from createSetupFeeInvoice because the signing request needs the pay link back
 * immediately, but must not wait on a PDF render and a mail send to return. Signing awaits the
 * create; the email is fired and forgotten.
 */
export async function emailSetupFeeInvoice(d: SetupFeeInvoiceData, opts?: { to?: string }): Promise<boolean> {
  const to = opts?.to || d.customerEmail;
  if (!to) {
    console.warn(`[SETUP-FEE] ${d.invoiceNumber} has no recipient — invoice raised but not emailed`);
    return false;
  }

  const pdf = await renderSetupFeeInvoicePdf(d);

  const cardBlockHtml = d.payUrl
    ? `<p style="font-size:14px;line-height:1.6;margin:18px 0 8px;">Pay by card:</p>
    <p style="margin:0 0 18px;"><a href="${d.payUrl}" style="display:inline-block;padding:12px 26px;background:${BRAND};color:#ffffff;text-decoration:none;border-radius:9px;font-weight:600;font-size:15px;">Pay ${gbp(d.grossPence)} by card</a></p>
    <p style="font-size:14px;line-height:1.6;margin:0 0 8px;">Or by bank transfer:</p>`
    : `<p style="font-size:14px;line-height:1.6;margin:18px 0 8px;">Payment by bank transfer:</p>`;

  const html = `
<div style="font-family:Inter,Arial,Helvetica,sans-serif;color:#334155;max-width:560px;margin:0 auto;">
  <div style="background:${BRAND};border-radius:12px;padding:18px 20px;text-align:center;">
    <img src="${RM_LOGO_URL}" alt="ReceptionMate" style="height:44px;width:auto;">
  </div>
  <div style="padding:24px 6px;">
    <p style="font-size:15px;color:${INK_900};margin:0 0 12px;">Hi,</p>
    <p style="font-size:14px;line-height:1.6;margin:0 0 14px;">Thanks for signing up. Your invoice for the one-off setup fee is attached — this covers your integration, agent build and configuration.</p>
    <table style="font-size:14px;border-collapse:collapse;margin:0 0 16px;">
      <tr><td style="color:${INK_500};padding:3px 18px 3px 0;">Invoice</td><td style="color:${INK_900};font-weight:600;">${d.invoiceNumber}</td></tr>
      <tr><td style="color:${INK_500};padding:3px 18px 3px 0;">Amount due</td><td style="color:${INK_900};font-weight:700;">${gbp(d.grossPence)} inc VAT</td></tr>
      <tr><td style="color:${INK_500};padding:3px 18px 3px 0;">Due</td><td style="color:${INK_900};font-weight:600;">On signing — today</td></tr>
    </table>
    ${cardBlockHtml}
    <div style="background:${BRAND_50};border-radius:10px;padding:14px 18px;font-size:14px;line-height:1.7;color:${INK_900};">
      ${BANK.name}<br>Sort code <b>${BANK.sort}</b> &middot; Account <b>${BANK.account}</b><br>Reference <b>${d.invoiceNumber}</b>
    </div>
    <p style="font-size:14px;line-height:1.6;margin:18px 0 4px;">We're already getting your integration set up — we'll email your login details as soon as your agent is ready.</p>
    <p style="font-size:14px;margin:14px 0 0;">Thanks,<br>ReceptionMate</p>
  </div>
  <div style="border-top:1px solid ${INK_200};padding-top:14px;font-size:11px;color:${INK_400};text-align:center;">${COMPANY_FOOTER}</div>
</div>`;

  const text = `Hi,

Thanks for signing up. Your invoice for the one-off setup fee is attached — this covers your integration, agent build and configuration.

Invoice: ${d.invoiceNumber}
Amount due: ${gbp(d.grossPence)} inc VAT
Due: on signing — today
${d.payUrl ? `\nPay by card: ${d.payUrl}\n` : ''}
Or by bank transfer:
${BANK.name}
Sort code ${BANK.sort} · Account ${BANK.account}
Reference ${d.invoiceNumber}

We're already getting your integration set up — we'll email your login details as soon as your agent is ready.

Thanks,
ReceptionMate`;

  const ok = await sendEmail({
    to: [to],
    subject: `ReceptionMate — Setup fee invoice ${d.invoiceNumber}`,
    html,
    text,
    attachments: [{ filename: `ReceptionMate-Invoice-${d.invoiceNumber}.pdf`, content: pdf, contentType: 'application/pdf' }],
  });
  console.log(`[SETUP-FEE] ${d.invoiceNumber} ${gbp(d.grossPence)} -> ${to} | sent=${ok} | card=${d.payUrl ? 'yes' : 'no'}`);
  return ok;
}

/**
 * Raise + email in one call. Convenience wrapper for callers that don't need the pay link back
 * synchronously (a staff resend button, a chase). Returns null when there's no fee to bill.
 */
export async function sendSetupFeeInvoice(agreementId: string, opts?: { to?: string }): Promise<SetupFeeInvoiceData | null> {
  const d = await createSetupFeeInvoice(agreementId);
  if (!d) return null;
  await emailSetupFeeInvoice(d, opts);
  return d;
}
