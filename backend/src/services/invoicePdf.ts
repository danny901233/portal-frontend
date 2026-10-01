import PDFDocument from 'pdfkit';
import { prisma } from '../db.js';
import https from 'https';

const LOGO_URL = 'https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png';
// Brand blue — the same chip colour the agreement PDF uses (agreementPdf.ts).
const BRAND = '#3426cf';

function fetchLogoBuffer(): Promise<Buffer> {
  return new Promise((resolve) => {
    https.get(LOGO_URL, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(Buffer.alloc(0)));
    }).on('error', () => resolve(Buffer.alloc(0)));
  });
}

interface InvoiceData {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  minutesUsed: number;
  minutesIncluded: number;
  smsCount: number;
  notificationSmsCount?: number;
  subscriptionAmount: number;
  minutesAmount: number;
  smsAmount: number;
  notificationSmsAmount?: number;
  // Connect, billed as a second subscription on the same garage.
  messagingSubscriptionAmount?: number;
  messagingMessagesAmount?: number;
  subtotal: number;
  vatAmount: number;
  total: number;
  subscriptionCostGbp: number;
  costPerMinuteGbp: number;
  vatRate: number;
  status: string;
  createdAt: Date;
  garage: {
    id: string;
    name: string;
    businessId: string | null;
  };
}

interface BusinessData {
  id: string;
  name: string;
  billingAddress: string | null;
  billingCity: string | null;
  billingPostcode: string | null;
  billingCountry: string | null;
  vatNumber: string | null;
  companyRegNumber: string | null;
}

/**
 * Generate a professional PDF invoice
 */
export async function generateInvoicePdf(invoiceId: string): Promise<Buffer> {
  // Fetch invoice with related data
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      garage: {
        select: {
          id: true,
          name: true,
          businessId: true,
        },
      },
    },
  });

  if (!invoice) {
    throw new Error('Invoice not found');
  }

  // Fetch business data if available
  let business: BusinessData | null = null;
  if (invoice.garage.businessId) {
    business = await prisma.business.findUnique({
      where: { id: invoice.garage.businessId },
      select: {
        id: true,
        name: true,
        billingAddress: true,
        billingCity: true,
        billingPostcode: true,
        billingCountry: true,
        vatNumber: true,
        companyRegNumber: true,
      },
    });
  }

  return createPdfBuffer(invoice as InvoiceData, business);
}

/**
 * Create PDF document and return as buffer
 */
function createPdfBuffer(invoice: InvoiceData, business: BusinessData | null): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    const logoBuffer = await fetchLogoBuffer();
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const buffers: Buffer[] = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(buffers);
      resolve(pdfBuffer);
    });
    doc.on('error', reject);

    // Add content to PDF
    addHeader(doc, logoBuffer);
    addInvoiceDetails(doc, invoice, business);
    addLineItems(doc, invoice);
    addTotals(doc, invoice);
    addFooter(doc);

    doc.end();
  });
}

/**
 * Add ReceptionMate header
 *
 * The logo is white on a transparent background — it is meant to sit on something dark. Drawn
 * straight onto the white page it rendered invisibly, so every invoice looked like it had no
 * logo at all while the code happily reported it had drawn one. Sit it on a brand-coloured chip,
 * exactly as the agreement PDF does (agreementPdf.ts), and size the chip to the image so a
 * different logo file cannot leave a band of empty blue.
 *
 * The chip is deliberately kept inside y=45..89: the contact lines below start at y=95, and the
 * old full-width 140pt logo would have overlapped them had it ever been visible.
 */
function addHeader(doc: typeof PDFDocument.prototype, logoBuffer: Buffer) {
  let logoDrawn = false;

  if (logoBuffer.length > 0) {
    try {
      const chipX = 50;
      const chipY = 45;
      const chipH = 44;
      const logoH = chipH - 16;
      const image = doc.openImage(logoBuffer);
      const logoW = (image.width / image.height) * logoH;

      doc.save().roundedRect(chipX, chipY, logoW + 24, chipH, 8).fill(BRAND).restore();
      doc.image(logoBuffer, chipX + 12, chipY + 8, { height: logoH });
      doc.fillColor('#000000');
      logoDrawn = true;
    } catch {
      /* A decorative header must never cost us the invoice — fall back to the wordmark. */
    }
  }

  if (!logoDrawn) {
    doc
      .fontSize(24)
      .font('Helvetica-Bold')
      .text('ReceptionMate', 50, 50);
  }

  doc
    .fontSize(10)
    .font('Helvetica')
    .text('AI Phone Answering Service', 50, 95)
    .text('hello@receptionmate.co.uk', 50, 110)
    .text('VAT Number: 494543753', 50, 125)
    .moveDown(2);
}

/**
 * Add invoice details and customer info
 */
function addInvoiceDetails(
  doc: typeof PDFDocument.prototype,
  invoice: InvoiceData,
  business: BusinessData | null
) {
  const startY = 140;

  // Invoice title
  doc
    .fontSize(20)
    .font('Helvetica-Bold')
    .text('INVOICE', 50, startY);

  // Invoice details (right side)
  const detailsX = 350;
  doc
    .fontSize(10)
    .font('Helvetica-Bold')
    .text('Invoice Number:', detailsX, startY)
    .font('Helvetica')
    .text(invoice.id.slice(0, 8).toUpperCase(), detailsX + 100, startY)
    .font('Helvetica-Bold')
    .text('Invoice Date:', detailsX, startY + 15)
    .font('Helvetica')
    .text(formatDate(invoice.createdAt), detailsX + 100, startY + 15)
    .font('Helvetica-Bold')
    .text('Billing Period:', detailsX, startY + 30)
    .font('Helvetica')
    .text(
      `${formatDate(invoice.periodStart)} - ${formatDate(invoice.periodEnd)}`,
      detailsX + 100,
      startY + 30
    );

  // Customer details (left side)
  const customerY = startY + 60;
  doc
    .fontSize(11)
    .font('Helvetica-Bold')
    .text('BILL TO:', 50, customerY);

  let currentY = customerY + 20;
  doc.fontSize(10).font('Helvetica');

  if (business) {
    doc.text(business.name, 50, currentY);
    currentY += 15;

    if (business.billingAddress) {
      doc.text(business.billingAddress, 50, currentY);
      currentY += 15;
    }

    if (business.billingCity || business.billingPostcode) {
      const cityPostcode = [business.billingCity, business.billingPostcode]
        .filter(Boolean)
        .join(' ');
      doc.text(cityPostcode, 50, currentY);
      currentY += 15;
    }

    if (business.billingCountry) {
      doc.text(business.billingCountry, 50, currentY);
      currentY += 15;
    }

    currentY += 10;

    if (business.vatNumber) {
      doc.font('Helvetica-Bold').text('VAT Number: ', 50, currentY, { continued: true })
        .font('Helvetica').text(business.vatNumber);
      currentY += 15;
    }

    if (business.companyRegNumber) {
      doc.font('Helvetica-Bold').text('Company Reg: ', 50, currentY, { continued: true })
        .font('Helvetica').text(business.companyRegNumber);
      currentY += 15;
    }
  } else {
    doc.text(invoice.garage.name, 50, currentY);
    currentY += 15;
  }

  doc.fontSize(10).font('Helvetica');
  doc.text(`Branch: ${invoice.garage.name}`, 50, currentY);

  return currentY + 30;
}

/**
 * Add line items table
 */
function addLineItems(doc: typeof PDFDocument.prototype, invoice: InvoiceData) {
  const tableTop = 420;
  const itemX = 50;
  const descX = 250;
  const amountX = 480;

  // Table header
  doc
    .fontSize(11)
    .font('Helvetica-Bold')
    .text('Description', itemX, tableTop)
    .text('Details', descX, tableTop)
    .text('Amount', amountX, tableTop);

  // Horizontal line
  doc
    .strokeColor('#aaaaaa')
    .lineWidth(1)
    .moveTo(50, tableTop + 20)
    .lineTo(550, tableTop + 20)
    .stroke();

  let currentY = tableTop + 35;
  doc.fontSize(10).font('Helvetica');

  // Subscription
  if (invoice.subscriptionAmount > 0) {
    doc.text('Monthly Subscription', itemX, currentY);
    doc.text(`£${invoice.subscriptionCostGbp.toFixed(2)}/month`, descX, currentY);
    doc.text(`£${(invoice.subscriptionAmount / 100).toFixed(2)}`, amountX, currentY);
    currentY += 25;
  }

  // Call minutes
  const overageMinutes = Math.max(0, invoice.minutesUsed - invoice.minutesIncluded);
  doc.text('Call Minutes', itemX, currentY);

  let minutesDesc = `${invoice.minutesUsed} used, ${invoice.minutesIncluded} included`;
  if (overageMinutes > 0) {
    minutesDesc += `\n${overageMinutes} overage @ £${invoice.costPerMinuteGbp.toFixed(2)}/min`;
  }
  doc.text(minutesDesc, descX, currentY);

  const minutesDisplay = invoice.minutesAmount > 0
    ? `£${(invoice.minutesAmount / 100).toFixed(2)}`
    : 'Included';
  doc.text(minutesDisplay, amountX, currentY);
  currentY += overageMinutes > 0 ? 40 : 25;

  // SMS
  if (invoice.smsCount > 0) {
    doc.text('SMS Messages', itemX, currentY);
    doc.text(`${invoice.smsCount} sent @ £0.99/SMS`, descX, currentY);
    doc.text(`£${(invoice.smsAmount / 100).toFixed(2)}`, amountX, currentY);
    currentY += 25;
  }

  if ((invoice.notificationSmsCount ?? 0) > 0) {
    doc.text('Notification SMS', itemX, currentY);
    doc.text(`${invoice.notificationSmsCount} sent @ £0.20/SMS`, descX, currentY);
    doc.text(`£${((invoice.notificationSmsAmount ?? 0) / 100).toFixed(2)}`, amountX, currentY);
    currentY += 25;
  }

  return currentY;
}

/**
 * Add totals section
 */
function addTotals(doc: typeof PDFDocument.prototype, invoice: InvoiceData) {
  const totalsX = 350;
  let currentY = 580;

  doc.fontSize(10).font('Helvetica');

  // Subtotal
  doc.text('Subtotal:', totalsX, currentY);
  doc.text(`£${(invoice.subtotal / 100).toFixed(2)}`, 480, currentY);
  currentY += 20;

  // VAT
  const vatPercentage = (invoice.vatRate * 100).toFixed(0);
  doc.text(`VAT (${vatPercentage}%):`, totalsX, currentY);
  doc.text(`£${(invoice.vatAmount / 100).toFixed(2)}`, 480, currentY);
  currentY += 20;

  // Line
  doc
    .strokeColor('#000000')
    .lineWidth(1.5)
    .moveTo(totalsX, currentY)
    .lineTo(550, currentY)
    .stroke();
  currentY += 15;

  // Total
  doc.fontSize(12).font('Helvetica-Bold');
  doc.text('TOTAL:', totalsX, currentY);
  doc.text(`£${(invoice.total / 100).toFixed(2)}`, 480, currentY);
  currentY += 30;

  // Payment info
  doc.fontSize(9).font('Helvetica');
  doc.text('Payment method: Direct Debit', totalsX, currentY);
  currentY += 15;

  if (invoice.status === 'paid') {
    doc.fillColor('#059669').text('✓ PAID', totalsX, currentY);
  } else if (invoice.status === 'pending') {
    doc.fillColor('#f59e0b').text('Payment Pending', totalsX, currentY);
  }
  doc.fillColor('#000000');
}

/**
 * Add footer
 */
function addFooter(doc: typeof PDFDocument.prototype) {
  doc
    .fontSize(9)
    .font('Helvetica')
    .fillColor('#666666')
    .text(
      'Thank you for using ReceptionMate. Questions? Contact hello@receptionmate.co.uk',
      50,
      720,
      { align: 'center' }
    )
    .text(
      `ReceptionMate © ${new Date().getFullYear()} | All rights reserved`,
      50,
      735,
      { align: 'center' }
    );
}

/**
 * Format date as DD/MM/YYYY
 */
function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Combined (per-business) invoice
// ---------------------------------------------------------------------------

/**
 * A group's invoice: one document, one total, a section per branch.
 *
 * The Direct Debit has always been a single combined collection, but the paperwork was one
 * invoice per branch — so a two-branch customer got two documents for one payment and no page
 * anywhere showed what the collection actually was. The per-branch Invoice rows still exist
 * underneath (arrears, chasing and reconciliation all read them); this only changes what the
 * customer is handed.
 *
 * Only businesses with `combinedInvoicing` use this, so nobody's invoices change shape
 * mid-contract.
 */
export async function generateCombinedInvoicePdf(
  businessId: string,
  periodStart: Date,
): Promise<Buffer> {
  // A period is a calendar span, and the branches of one business are invoiced in the same run
  // — but not always within the same second, so match the day rather than the timestamp.
  const dayStart = new Date(periodStart);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const invoices = await prisma.invoice.findMany({
    where: {
      periodStart: { gte: dayStart, lt: dayEnd },
      garage: { businessId },
    },
    include: { garage: { select: { id: true, name: true, businessId: true } } },
    orderBy: { garage: { name: 'asc' } },
  });

  if (invoices.length === 0) throw new Error('No invoices for this business and period');

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      billingAddress: true,
      billingCity: true,
      billingPostcode: true,
      billingCountry: true,
      vatNumber: true,
      companyRegNumber: true,
    },
  });

  return renderCombinedInvoicePdf(
    invoices as unknown as InvoiceData[],
    business,
    combinedInvoiceNumber(businessId, dayStart),
  );
}

/** A group's totals run into four figures, where 1090.80 is hard to read at a glance. */
const GBP_MONEY = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const money = (pence: number) => GBP_MONEY.format(pence / 100);

/** INV-AB12-2609 — stable for a business and month, so the customer can quote it back. */
export function combinedInvoiceNumber(businessId: string, periodStart: Date): string {
  const ref = businessId.slice(-4).toUpperCase();
  const d = new Date(periodStart);
  return `INV-${ref}-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** The renderer itself, separate from the fetching so it can be exercised without a database. */
export function renderCombinedInvoicePdf(
  invoices: InvoiceData[],
  business: BusinessData | null,
  invoiceNumber: string,
): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    const logoBuffer = await fetchLogoBuffer();
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const buffers: Buffer[] = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const first = invoices[0];
    addHeader(doc, logoBuffer);

    // --- title + invoice meta ---
    const startY = 140;
    doc.fontSize(20).font('Helvetica-Bold').text('INVOICE', 50, startY);
    const detailsX = 350;
    doc.fontSize(10).font('Helvetica-Bold').text('Invoice Number:', detailsX, startY)
      .font('Helvetica').text(invoiceNumber, detailsX + 100, startY)
      .font('Helvetica-Bold').text('Invoice Date:', detailsX, startY + 15)
      .font('Helvetica').text(formatDate(first.createdAt), detailsX + 100, startY + 15)
      .font('Helvetica-Bold').text('Billing Period:', detailsX, startY + 30)
      .font('Helvetica').text(`${formatDate(first.periodStart)} - ${formatDate(first.periodEnd)}`, detailsX + 100, startY + 30);

    // --- bill to ---
    let y = startY + 60;
    doc.fontSize(11).font('Helvetica-Bold').text('BILL TO:', 50, y);
    y += 20;
    doc.fontSize(10).font('Helvetica');
    if (business) {
      doc.text(business.name, 50, y); y += 15;
      if (business.billingAddress) { doc.text(business.billingAddress, 50, y); y += 15; }
      const cityPostcode = [business.billingCity, business.billingPostcode].filter(Boolean).join(' ');
      if (cityPostcode) { doc.text(cityPostcode, 50, y); y += 15; }
      if (business.billingCountry) { doc.text(business.billingCountry, 50, y); y += 15; }
      y += 10;
      if (business.vatNumber) {
        doc.font('Helvetica-Bold').text('VAT Number: ', 50, y, { continued: true }).font('Helvetica').text(business.vatNumber);
        y += 15;
      }
      if (business.companyRegNumber) {
        doc.font('Helvetica-Bold').text('Company Reg: ', 50, y, { continued: true }).font('Helvetica').text(business.companyRegNumber);
        y += 15;
      }
    } else {
      doc.text(first.garage.name, 50, y); y += 15;
    }
    doc.fontSize(10).font('Helvetica')
      .text(`${invoices.length} branch${invoices.length === 1 ? '' : 'es'} on this invoice`, 50, y);
    y += 30;

    // --- one section per branch ---
    for (const inv of invoices) {
      y = ensureSpace(doc, y, 130);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1d1a72').text(inv.garage.name, 50, y);
      doc.fillColor('#000000');
      y += 18;
      y = addBranchLines(doc, inv, y);
      doc.fontSize(10).font('Helvetica-Bold')
        .text('Branch total (ex VAT)', 350, y)
        .text(money(inv.subtotal), 480, y);
      doc.font('Helvetica');
      y += 18;
      doc.strokeColor('#e2e8f0').lineWidth(1).moveTo(50, y).lineTo(550, y).stroke();
      y += 18;
    }

    // --- one total for the group ---
    const subtotal = invoices.reduce((s, i) => s + i.subtotal, 0);
    const vatAmount = invoices.reduce((s, i) => s + i.vatAmount, 0);
    const total = invoices.reduce((s, i) => s + i.total, 0);
    y = ensureSpace(doc, y, 120);
    const totalsX = 350;
    doc.fontSize(10).font('Helvetica');
    doc.text('Subtotal:', totalsX, y); doc.text(money(subtotal), 480, y); y += 20;
    doc.text(`VAT (${(first.vatRate * 100).toFixed(0)}%):`, totalsX, y);
    doc.text(money(vatAmount), 480, y); y += 20;
    doc.strokeColor('#000000').lineWidth(1.5).moveTo(totalsX, y).lineTo(550, y).stroke();
    y += 15;
    doc.fontSize(12).font('Helvetica-Bold');
    doc.text('TOTAL:', totalsX, y); doc.text(money(total), 480, y);
    y += 30;
    doc.fontSize(9).font('Helvetica');
    doc.text('Payment method: Direct Debit — collected as one payment for all branches.', totalsX - 120, y);
    y += 15;
    // One collection, so the group's status is only "paid" when every branch's is.
    const statuses = new Set(invoices.map((i) => i.status.toLowerCase()));
    if (statuses.size === 1 && statuses.has('paid')) {
      doc.fillColor('#059669').text('✓ PAID', totalsX, y);
    } else if (statuses.has('failed')) {
      doc.fillColor('#dc2626').text('Payment Failed', totalsX, y);
    } else if (statuses.has('pending')) {
      doc.fillColor('#f59e0b').text('Payment Pending', totalsX, y);
    }
    doc.fillColor('#000000');

    addFooter(doc);
    doc.end();
  });
}

/** Start a new page when the next block would not fit above the footer. */
function ensureSpace(doc: typeof PDFDocument.prototype, y: number, needed: number): number {
  if (y + needed < 700) return y;
  doc.addPage();
  return 60;
}

/** The charge lines for one branch, laid out under its heading. */
function addBranchLines(doc: typeof PDFDocument.prototype, invoice: InvoiceData, startY: number): number {
  const itemX = 60;
  const descX = 250;
  const amountX = 480;
  let y = startY;
  doc.fontSize(9).font('Helvetica');

  if (invoice.subscriptionAmount > 0) {
    doc.text('Voice subscription', itemX, y);
    doc.text(`£${invoice.subscriptionCostGbp.toFixed(2)}/month`, descX, y);
    doc.text(money(invoice.subscriptionAmount), amountX, y);
    y += 16;
  }

  const messagingSubscription = invoice.messagingSubscriptionAmount ?? 0;
  if (messagingSubscription > 0) {
    doc.text('Connect subscription', itemX, y);
    doc.text('Messaging', descX, y);
    doc.text(money(messagingSubscription), amountX, y);
    y += 16;
  }

  const overageMinutes = Math.max(0, invoice.minutesUsed - invoice.minutesIncluded);
  if (invoice.minutesIncluded > 0 || invoice.minutesUsed > 0) {
    doc.text('Call minutes', itemX, y);
    doc.text(
      overageMinutes > 0
        ? `${invoice.minutesUsed} used, ${invoice.minutesIncluded} included — ${overageMinutes} @ £${invoice.costPerMinuteGbp.toFixed(2)}`
        : `${invoice.minutesUsed} used, ${invoice.minutesIncluded} included`,
      descX, y,
    );
    doc.text(invoice.minutesAmount > 0 ? money(invoice.minutesAmount) : 'Included', amountX, y);
    y += 16;
  }

  const messagingMessages = invoice.messagingMessagesAmount ?? 0;
  if (messagingMessages > 0) {
    doc.text('Messaging overage', itemX, y);
    doc.text('Beyond the included conversations', descX, y);
    doc.text(money(messagingMessages), amountX, y);
    y += 16;
  }

  if (invoice.smsCount > 0) {
    doc.text('SMS messages', itemX, y);
    doc.text(`${invoice.smsCount} sent @ £0.99`, descX, y);
    doc.text(money(invoice.smsAmount), amountX, y);
    y += 16;
  }

  if ((invoice.notificationSmsCount ?? 0) > 0) {
    doc.text('Notification SMS', itemX, y);
    doc.text(`${invoice.notificationSmsCount} sent @ £0.20`, descX, y);
    doc.text(money((invoice.notificationSmsAmount ?? 0)), amountX, y);
    y += 16;
  }

  return y;
}
