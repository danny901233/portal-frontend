import PDFDocument from 'pdfkit';
import { prisma } from '../db.js';

interface InvoiceData {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  minutesUsed: number;
  minutesIncluded: number;
  smsCount: number;
  subscriptionAmount: number;
  minutesAmount: number;
  smsAmount: number;
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
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const buffers: Buffer[] = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(buffers);
      resolve(pdfBuffer);
    });
    doc.on('error', reject);

    // Add content to PDF
    addHeader(doc);
    addInvoiceDetails(doc, invoice, business);
    addLineItems(doc, invoice);
    addTotals(doc, invoice);
    addFooter(doc);

    doc.end();
  });
}

/**
 * Add ReceptionMate header
 */
function addHeader(doc: typeof PDFDocument.prototype) {
  // TODO: Add logo image here when available
  // doc.image('path/to/logo.png', 50, 45, { width: 150 });

  doc
    .fontSize(24)
    .font('Helvetica-Bold')
    .text('ReceptionMate', 50, 50)
    .fontSize(10)
    .font('Helvetica')
    .text('AI Phone Answering Service', 50, 80)
    .text('hello@receptionmate.co.uk', 50, 95)
    .text('VAT Number: 494543753', 50, 110)
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
