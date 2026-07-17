import PDFDocument from 'pdfkit';
import { prisma } from '../db.js';
import { sendEmail } from '../utils/email.js';

/**
 * Automated monthly invoice for In'n'out Autocentres.
 *
 * In'n'out pay by their own Direct Debit against an emailed invoice (they are NOT in the
 * GoCardless auto-charge flow). So on the 1st of each month we: compute the combined bill for
 * all four branches (each £365 subscription for the coming month + the previous month's call
 * minutes at their per-minute rate + VAT), render a PDF, and email it to their accounts team.
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

const LOGO_URL = 'https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png';

// ReceptionMate Ltd payment + company details (their own bank account).
const BANK = { name: 'ReceptionMate Ltd', sort: '23-01-20', account: '49981874' };
const COMPANY = 'ReceptionMate Ltd · Studio 9, 50–54 St. Paul’s Square, Birmingham B3 1QS · VAT 494543753 · Company 16839506';
const RECIPIENTS = ['accounts@inocentres.co.uk', 'dan@receptionmate.co.uk'];
const VAT_RATE = 0.2;

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const gbp = (pence: number) => `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const shortBranch = (name: string) => name.replace(/In'n'out Autocentres\s*/i, '').trim() || name;

interface InoLine { branch: string; garageId: string; businessId: string | null; subPence: number; minutes: number; ratePence: number; minutesPence: number; }
interface InoInvoiceData {
  lines: InoLine[]; subtotal: number; vat: number; total: number;
  invoiceNo: string; issued: Date; periodEnd: Date; due: Date; subMonthLabel: string; usageMonthLabel: string;
}

/** Compute the invoice for the month that `now` falls in (subscription = this month, usage = last month). */
export async function buildInoInvoiceData(now: Date = new Date()): Promise<InoInvoiceData> {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const usageStart = new Date(Date.UTC(y, m - 1, 1));
  const usageEnd = new Date(Date.UTC(y, m, 1)); // exclusive
  const issued = new Date(Date.UTC(y, m, 1));
  const periodEnd = new Date(Date.UTC(y, m + 1, 1));
  const due = new Date(issued.getTime() + 14 * 86400000);

  const branches = await prisma.garage.findMany({
    where: { name: { contains: 'autocentres', mode: 'insensitive' } },
    select: { id: true, name: true, businessId: true, subscriptionCostGbp: true, costPerMinuteGbp: true },
    orderBy: { name: 'asc' },
  });

  const lines: InoLine[] = [];
  for (const b of branches) {
    const calls = await prisma.call.findMany({
      where: { garageId: b.id, createdAt: { gte: usageStart, lt: usageEnd } },
      select: { durationSeconds: true },
    });
    const minutes = Math.ceil(calls.reduce((s, c) => s + c.durationSeconds, 0) / 60);
    lines.push({
      branch: shortBranch(b.name),
      garageId: b.id,
      businessId: b.businessId,
      subPence: Math.round(b.subscriptionCostGbp * 100),
      minutes,
      ratePence: Math.round(b.costPerMinuteGbp * 100),
      minutesPence: Math.round(minutes * b.costPerMinuteGbp * 100),
    });
  }

  const subtotal = lines.reduce((s, l) => s + l.subPence + l.minutesPence, 0);
  const vat = Math.round(subtotal * VAT_RATE);
  const total = subtotal + vat;
  const invoiceNo = `INV-INO-${String(y).slice(2)}${String(m + 1).padStart(2, '0')}`;

  return {
    lines, subtotal, vat, total, invoiceNo, issued, periodEnd, due,
    subMonthLabel: `${MONTHS[m]} ${y}`,
    usageMonthLabel: `${MONTHS[usageStart.getUTCMonth()]} ${usageStart.getUTCFullYear()}`,
  };
}

/**
 * Persist one Invoice record per branch (status 'pending') so the invoice is tracked in the
 * portal and can be marked paid when In'n'out's Direct Debit lands. Idempotent — skips a branch
 * that already has an invoice for this month. Returns the created invoice ids.
 */
export async function createInoInvoiceRecords(data: InoInvoiceData): Promise<string[]> {
  const ids: string[] = [];
  for (const line of data.lines) {
    const existing = await prisma.invoice.findFirst({ where: { garageId: line.garageId, periodStart: data.issued } });
    if (existing) { ids.push(existing.id); continue; }
    const subtotal = line.subPence + line.minutesPence;
    const vat = Math.round(subtotal * VAT_RATE);
    const inv = await prisma.invoice.create({
      data: {
        garageId: line.garageId,
        businessId: line.businessId,
        periodStart: data.issued,
        periodEnd: data.periodEnd,
        minutesUsed: line.minutes,
        minutesIncluded: 0,
        subscriptionAmount: line.subPence,
        minutesAmount: line.minutesPence,
        smsAmount: 0,
        messagingSubscriptionAmount: 0,
        subtotal,
        vatAmount: vat,
        total: subtotal + vat,
        subscriptionCostGbp: line.subPence / 100,
        costPerMinuteGbp: line.ratePence / 100,
        vatRate: VAT_RATE,
        status: 'pending', // awaiting In'n'out's manual Direct Debit; mark paid in the portal when it lands
      },
    });
    ids.push(inv.id);
  }
  return ids;
}

async function fetchLogo(): Promise<Buffer | null> {
  try {
    const r = await fetch(LOGO_URL);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

export async function renderInoInvoicePdf(data: InoInvoiceData): Promise<Buffer> {
  const logo = await fetchLogo();
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const L = 44;        // left margin
      const R = 595.28 - 44; // right edge
      let y = 44;

      // --- header: logo box + Invoice / number ---
      const boxH = 74;
      doc.roundedRect(L, y, 150, boxH, 14).fill(BRAND);
      if (logo) {
        try { doc.image(logo, L + 22, y + 20, { height: 34 }); } catch { /* fall back below */ }
      }
      if (!logo) {
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19).text('ReceptionMate', L + 18, y + 27);
      }
      doc.fillColor(INK_900).font('Helvetica-Bold').fontSize(28).text('Invoice', R - 200, y + 8, { width: 200, align: 'right' });
      doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(12).text(data.invoiceNo, R - 200, y + 44, { width: 200, align: 'right' });
      y += boxH + 26;

      // --- billed to / invoice details ---
      doc.fillColor(INK_400).font('Helvetica-Bold').fontSize(8).text('BILLED TO', L, y);
      doc.fillColor(INK_900).font('Helvetica-Bold').fontSize(12).text("In'n'out Autocentres", L, y + 14);
      doc.fillColor(INK_700).font('Helvetica').fontSize(10).text('accounts@inocentres.co.uk', L, y + 30);
      doc.fillColor(INK_500).fontSize(9.5).text('Basingstoke · Norwich · Spalding · Erith', L, y + 44);

      const dX = 330, dValX = R - 130;
      const detailRows: [string, string][] = [
        ['Issued', fmtDate(data.issued)],
        ['Due', fmtDate(data.due)],
        ['Terms', '14 days'],
        ['Subscription', data.subMonthLabel],
        ['Usage period', data.usageMonthLabel],
      ];
      doc.fillColor(INK_400).font('Helvetica-Bold').fontSize(8).text('INVOICE DETAILS', dX, y);
      let dy = y + 14;
      for (const [k, v] of detailRows) {
        doc.fillColor(INK_500).font('Helvetica').fontSize(10).text(k, dX, dy);
        doc.fillColor(INK_900).font('Helvetica-Bold').fontSize(10).text(v, dValX, dy, { width: 130, align: 'right' });
        dy += 15;
      }
      y = Math.max(y + 62, dy) + 12;

      // --- line items table ---
      const colQty = 350, colRate = 430, colAmt = R - 70;
      doc.rect(L, y, R - L, 24).fill(INK_50);
      doc.fillColor(INK_500).font('Helvetica-Bold').fontSize(8);
      doc.text('DESCRIPTION', L + 10, y + 8);
      doc.text('QTY', colQty, y + 8, { width: 50, align: 'right' });
      doc.text('RATE', colRate, y + 8, { width: 60, align: 'right' });
      doc.text('AMOUNT', colAmt - 20, y + 8, { width: 90, align: 'right' });
      y += 30;

      for (const line of data.lines) {
        doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(9).text(line.branch.toUpperCase(), L + 2, y);
        y += 15;
        // subscription row
        doc.fillColor(INK_700).font('Helvetica').fontSize(10).text('Monthly subscription', L + 10, y);
        doc.fillColor(INK_900).text('1', colQty, y, { width: 50, align: 'right' });
        doc.text(gbp(line.subPence), colRate, y, { width: 60, align: 'right' });
        doc.text(gbp(line.subPence), colAmt - 20, y, { width: 90, align: 'right' });
        y += 16;
        // minutes row
        doc.fillColor(INK_700).font('Helvetica').fontSize(10).text('Call minutes', L + 10, y);
        doc.fillColor(INK_900).text(String(line.minutes), colQty, y, { width: 50, align: 'right' });
        doc.text(gbp(line.ratePence), colRate, y, { width: 60, align: 'right' });
        doc.text(gbp(line.minutesPence), colAmt - 20, y, { width: 90, align: 'right' });
        y += 18;
        doc.moveTo(L, y - 4).lineTo(R, y - 4).lineWidth(0.5).strokeColor(INK_200).stroke();
      }

      // --- totals ---
      y += 12;
      const tLabelX = R - 250, tValX = R - 90;
      doc.fillColor(INK_700).font('Helvetica').fontSize(11).text('Subtotal', tLabelX, y, { width: 130, align: 'right' });
      doc.fillColor(INK_900).text(gbp(data.subtotal), tValX, y, { width: 90, align: 'right' });
      y += 20;
      doc.fillColor(INK_700).text('VAT (20%)', tLabelX, y, { width: 130, align: 'right' });
      doc.fillColor(INK_900).text(gbp(data.vat), tValX, y, { width: 90, align: 'right' });
      y += 24;
      doc.roundedRect(R - 250, y, 250, 44, 12).fill(BRAND);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text('TOTAL DUE', R - 240, y + 16);
      doc.fontSize(18).text(gbp(data.total), R - 160, y + 12, { width: 150, align: 'right' });
      y += 44 + 22;

      // --- payment details ---
      doc.roundedRect(L, y, R - L, 66, 14).fillAndStroke(BRAND_50, BRAND_100);
      doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(8).text('PAYMENT — BANK TRANSFER / DIRECT DEBIT', L + 18, y + 14);
      const pays: [string, string][] = [
        ['Account name', BANK.name], ['Sort code', BANK.sort], ['Account number', BANK.account], ['Reference', data.invoiceNo],
      ];
      const cellW = (R - L - 36) / 4;
      pays.forEach(([k, v], i) => {
        const cx = L + 18 + i * cellW;
        doc.fillColor(INK_500).font('Helvetica').fontSize(9).text(k, cx, y + 32);
        doc.fillColor(INK_900).font('Helvetica-Bold').fontSize(11).text(v, cx, y + 45);
      });
      y += 66 + 24;

      // --- footer ---
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(INK_200).stroke();
      doc.fillColor(INK_400).font('Helvetica').fontSize(8.5).text(COMPANY, L, y + 12, { width: R - L, align: 'center' });
      doc.fillColor(INK_500).fontSize(8.5).text('Thank you for your business — questions? hello@receptionmate.co.uk', L, y + 26, { width: R - L, align: 'center' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/** Build + render + email the In'n'out invoice. Returns true on success. */
export async function sendInoInvoice(opts: { to?: string[]; now?: Date; record?: boolean } = {}): Promise<boolean> {
  const data = await buildInoInvoiceData(opts.now);
  if (opts.record !== false) {
    const ids = await createInoInvoiceRecords(data);
    console.log(`[INO-INVOICE] recorded ${ids.length} branch invoice(s) for ${data.invoiceNo}`);
  }
  const pdf = await renderInoInvoicePdf(data);
  const to = opts.to ?? RECIPIENTS;

  const html = `
<div style="font-family:Inter,Arial,Helvetica,sans-serif;color:#334155;max-width:560px;margin:0 auto;">
  <div style="background:#3426cf;border-radius:12px;padding:18px 20px;text-align:center;">
    <img src="${LOGO_URL}" alt="ReceptionMate" style="height:44px;width:auto;">
  </div>
  <div style="padding:24px 6px;">
    <p style="font-size:15px;color:#0f172a;margin:0 0 12px;">Hi,</p>
    <p style="font-size:14px;line-height:1.6;margin:0 0 14px;">Please find attached your ReceptionMate invoice for <b>${data.subMonthLabel}</b> (subscription plus ${data.usageMonthLabel} call usage across your four branches).</p>
    <table style="font-size:14px;border-collapse:collapse;margin:0 0 16px;">
      <tr><td style="color:#64748b;padding:3px 18px 3px 0;">Invoice</td><td style="color:#0f172a;font-weight:600;">${data.invoiceNo}</td></tr>
      <tr><td style="color:#64748b;padding:3px 18px 3px 0;">Amount due</td><td style="color:#0f172a;font-weight:700;">${gbp(data.total)} inc VAT</td></tr>
      <tr><td style="color:#64748b;padding:3px 18px 3px 0;">Due date</td><td style="color:#0f172a;font-weight:600;">${fmtDate(data.due)} (14 days)</td></tr>
    </table>
    <p style="font-size:14px;line-height:1.6;margin:0 0 8px;">Payment by bank transfer or Direct Debit:</p>
    <div style="background:#eef0fe;border-radius:10px;padding:14px 18px;font-size:14px;line-height:1.7;color:#0f172a;">
      ${BANK.name}<br>Sort code <b>${BANK.sort}</b> &middot; Account <b>${BANK.account}</b><br>Reference <b>${data.invoiceNo}</b>
    </div>
    <p style="font-size:14px;line-height:1.6;margin:18px 0 4px;">Any questions, just reply to this email.</p>
    <p style="font-size:14px;margin:0;">Thanks,<br>ReceptionMate</p>
  </div>
  <div style="border-top:1px solid #e2e8f0;padding-top:14px;font-size:11px;color:#94a3b8;text-align:center;">${COMPANY}</div>
</div>`;

  const text = `Hi,

Please find attached your ReceptionMate invoice for ${data.subMonthLabel} (subscription plus ${data.usageMonthLabel} call usage across your four branches).

Invoice: ${data.invoiceNo}
Amount due: ${gbp(data.total)} inc VAT
Due date: ${fmtDate(data.due)} (14 days)

Payment by bank transfer or Direct Debit:
${BANK.name}
Sort code ${BANK.sort} · Account ${BANK.account}
Reference ${data.invoiceNo}

Any questions, just reply to this email.

Thanks,
ReceptionMate`;

  const ok = await sendEmail({
    to,
    subject: `ReceptionMate — Invoice ${data.invoiceNo} (${data.subMonthLabel})`,
    html,
    text,
    attachments: [{ filename: `ReceptionMate-Invoice-${data.invoiceNo}.pdf`, content: pdf, contentType: 'application/pdf' }],
  });
  console.log(`[INO-INVOICE] ${data.invoiceNo} ${gbp(data.total)} -> ${to.join(', ')} | sent=${ok}`);
  return ok;
}
