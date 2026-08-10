// PDF renderer for the signed partnership service agreement (FixMyCar deal).
// Mirrors agreementPdf.ts (pdfkit) but with the partnership clauses + fixed terms.

import PDFDocument from 'pdfkit';

const LOGO_URL = 'https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png';
let logoBufferPromise: Promise<Buffer | null> | null = null;
async function getLogoBuffer(): Promise<Buffer | null> {
  if (!logoBufferPromise) {
    logoBufferPromise = fetch(LOGO_URL)
      .then(async (r) => (r.ok ? Buffer.from(await r.arrayBuffer()) : null))
      .catch(() => null);
  }
  return logoBufferPromise;
}

export interface PartnershipPdfInputs {
  clientName: string;
  effectiveDate: Date | null;
  signedByName: string;
  signedByPosition: string;
  signatureImage?: string | null;
}

const BRAND = '#3426cf';
const INK = '#0f172a';
const MUTED = '#475569';
const BORDER = '#e2e8f0';

const FMT_DATE = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
const fmtDate = (d: Date | null): string => (d ? FMT_DATE.format(d) : '—');

export async function renderPartnershipPdf(inputs: PartnershipPdfInputs): Promise<Buffer> {
  const logo = await getLogoBuffer();
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (e) => reject(e));
    try {
      drawDocument(doc, inputs, logo);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

function drawDocument(doc: PDFKit.PDFDocument, inputs: PartnershipPdfInputs, logo: Buffer | null) {
  if (logo) {
    try {
      const chipX = doc.page.margins.left, chipY = doc.y, chipH = 44, chipW = 100;
      doc.save().roundedRect(chipX, chipY, chipW, chipH, 8).fill(BRAND).restore();
      doc.image(logo, chipX + 12, chipY + 8, { height: chipH - 16 });
      doc.y = chipY + chipH + 10;
    } catch { /* decorative */ }
  }
  doc.fillColor(BRAND).fontSize(20).font('Helvetica-Bold').text('Service Agreement', { align: 'left' });
  doc.moveDown(0.3);
  doc.fillColor(MUTED).fontSize(10).font('Helvetica').text(`Date: ${fmtDate(inputs.effectiveDate ?? new Date())}`);
  hr(doc);

  section(doc, 'Parties');
  para(doc, 'Provider: ReceptionMate Ltd, company no. 16839506, Studio 9, 50–54 St. Paul’s Square, Birmingham B3 1QS (VAT 494543753).');
  para(doc, `Client: ${inputs.clientName}, company no. 07455738, 1st Floor Suite 3, 100 Longwater Avenue, Green Park, Reading, Berkshire RG2 6GP.`);

  section(doc, 'Introduction');
  para(doc, `This Agreement sets out the terms of a partnership between ReceptionMate Ltd (the "Provider") and ${inputs.clientName} (the "Client") for the provision of ReceptionMate’s AI-powered booking-protection services across the Client’s marketplace.`);

  section(doc, '1. Definitions');
  bulletList(doc, [
    ['"Services"', ' means the ReceptionMate AI agents and related software that confirm, protect and follow up the Client’s bookings, including masked communications, reminders, cancellation handling and rebooking.'],
    ['"Booking"', ' means a booking placed through the Client’s marketplace; a "Managed Booking" is one handled by the Services.'],
    ['"Commission"', ' means the fee the Client earns in respect of a Booking.'],
    ['"Completion"', ' means the relevant job being carried out, at which point the Client earns its Commission.'],
    ['"Initial Period"', ' means the three (3) month trial period during which the Services are first provided.'],
    ['"Effective Date"', ' means the date of the last signature below.'],
  ]);

  section(doc, '2. Purpose and scope');
  numbered(doc, '2.1', 'The Provider agrees to supply, and the Client agrees to use, the Services to protect and grow the Client’s bookings: confirming bookings, keeping communications on a masked channel, reducing no-shows, saving cancellations, verifying attendance after the job, and rebooking customers for their next service.');
  numbered(doc, '2.2', 'The Services operate in the pre-arrival window and the post-job follow-up. Once a vehicle is dropped off, the garage and customer deal directly. On-site work and any additional work carried out at the garage are out of scope.');

  section(doc, '3. Term');
  numbered(doc, '3.1', 'This Agreement commences on the agreed go-live date and continues for the Initial Period of three (3) months.');
  numbered(doc, '3.2', 'After the Initial Period, this Agreement continues on a rolling monthly basis and will be reviewed by the Parties. Either Party may terminate in accordance with Clause 13.');

  section(doc, '4. Provider responsibilities');
  para(doc, 'The Provider shall: host and maintain the Platform; provide AI voice, WhatsApp and SMS agents for confirmation, masked communications, reminders, cancellation handling, post-job follow-up and rebooking; integrate with the Client’s booking system where technically feasible; handle WhatsApp template approval and compliance; provide weekly performance reporting during the Initial Period; and make the Services available 24 hours a day, subject to scheduled maintenance.');

  section(doc, '5. Fees and payment');
  numberedRich(doc, '5.1', [{ text: 'Setup fee.', bold: true }, { text: ' A one-off setup and integration fee of ' }, { text: '£2,500', bold: true }, { text: ' is due on signing this Agreement.' }]);
  numberedRich(doc, '5.2', [{ text: 'Service fee.', bold: true }, { text: ' The Provider shall charge ' }, { text: '3% of the Commission', bold: true }, { text: ' earned by the Client on each Managed Booking, charged on Completion of the relevant job. No fee is charged on bookings that do not complete.' }]);
  numberedRich(doc, '5.3', [{ text: 'Minimum monthly charge.', bold: true }, { text: ' A minimum charge of ' }, { text: '£2,500 per month', bold: true }, { text: ' applies. Where the Service Fee for a month is less than the minimum, the minimum is payable; where it is greater, the Service Fee applies.' }]);
  numberedRich(doc, '5.4', [{ text: 'Messaging and voice.', bold: true }, { text: ' Customer messaging (WhatsApp and SMS) is included. AI voice calls are included up to a fair-usage allowance of ' }, { text: '10,000 connected minutes per month', bold: true }, { text: '; connected minutes beyond the allowance are charged at ' }, { text: '£0.25 per minute', bold: true }, { text: '.' }]);
  numberedRich(doc, '5.5', [{ text: 'Invoicing.', bold: true }, { text: ' The setup fee is payable on signing. The Service Fee (or minimum) is invoiced monthly in arrears, based on Managed Bookings that reached Completion in the month. All fees are exclusive of VAT and payable within fourteen (14) days of invoice.' }]);

  section(doc, '6. Late payment');
  numbered(doc, '6.1', 'If any undisputed amount remains unpaid after its due date, the Provider may charge interest at 4% per annum above the Bank of England base rate, accruing daily until paid.');
  numbered(doc, '6.2', 'If payment remains outstanding for more than thirty (30) days, the Provider may, on five (5) days’ written notice, suspend the Services until overdue amounts are settled. Suspension does not relieve the Client of its obligation to pay.');

  section(doc, '7. Client responsibilities');
  para(doc, 'The Client shall: provide API access to its booking system so the Provider can confirm, reschedule and rebook; capture customer opt-in to messaging at the point of booking; provide the Commission information needed to calculate the Service Fee; provide reasonable feedback and performance data during the term; and comply with applicable laws relating to its use of the Services.');

  section(doc, '8. Intellectual property');
  para(doc, 'All intellectual property rights in the Platform, AI models and related software remain the exclusive property of the Provider. The Client is granted a limited, non-exclusive, non-transferable licence to use the Services for its internal business purposes during the term.');

  section(doc, '9. Data protection');
  numbered(doc, '9.1', 'Both Parties shall comply with the UK GDPR and the Data Protection Act 2018.');
  numbered(doc, '9.2', 'In respect of customer data, the Client is the Data Controller and the Provider is the Data Processor, processing such data solely to provide the Services.');
  numbered(doc, '9.3', 'The Provider shall implement appropriate technical and organisational measures to safeguard customer data and shall not share it with third parties except as necessary to deliver the Services or as required by law. The Parties shall enter into a separate Data Processing Agreement.');

  section(doc, '10. Confidentiality');
  para(doc, 'Each Party shall keep confidential all proprietary or confidential information disclosed by the other and use it only for the purposes of this Agreement. Commercial terms, including fees, are confidential to the Parties.');

  section(doc, '11. Publicity');
  para(doc, 'Neither Party shall use the other’s name or logo in marketing or public materials without that Party’s prior written approval. The Provider may refer to aggregate, anonymised performance results that do not identify the Client or its customers.');

  section(doc, '12. Limitation of liability');
  numbered(doc, '12.1', 'The Provider’s total liability under this Agreement shall not exceed the total fees paid by the Client in the preceding three (3) months.');
  numbered(doc, '12.2', 'Neither Party shall be liable for any indirect, special or consequential losses, including loss of profit, revenue or goodwill.');

  section(doc, '13. Termination');
  numbered(doc, '13.1', 'Either Party may terminate at any time after the Initial Period on thirty (30) days’ written notice.');
  numbered(doc, '13.2', 'Either Party may terminate immediately if the other commits a material breach that remains unremedied ten (10) days after written notice.');

  section(doc, '14. Force majeure');
  para(doc, 'Neither Party shall be liable for any failure or delay caused by circumstances beyond its reasonable control, including network failures or telecommunications outages.');

  section(doc, '15. Entire agreement');
  para(doc, 'This Agreement is the entire understanding between the Parties and supersedes all prior proposals or discussions on its subject matter. Any amendment must be in writing and signed by authorised representatives of both Parties.');

  section(doc, '16. Governing law');
  para(doc, 'This Agreement is governed by the laws of England and Wales, and the Parties submit to the exclusive jurisdiction of the courts of England and Wales.');

  signatureBlocks(doc, inputs);
}

function hr(doc: PDFKit.PDFDocument) {
  doc.moveDown(0.6);
  const y = doc.y;
  doc.strokeColor(BORDER).lineWidth(1).moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).stroke();
  doc.moveDown(0.6);
}
function section(doc: PDFKit.PDFDocument, title: string) {
  doc.moveDown(0.8);
  ensureRoom(doc, 60);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(title);
  doc.moveDown(0.25);
}
function para(doc: PDFKit.PDFDocument, text: string) {
  ensureRoom(doc, 40);
  doc.fillColor(INK).fontSize(10.5).font('Helvetica').text(text, { paragraphGap: 4, lineGap: 2 });
}
function numbered(doc: PDFKit.PDFDocument, label: string, body: string) {
  ensureRoom(doc, 40);
  doc.fillColor(INK).fontSize(10.5);
  doc.font('Helvetica-Bold').text(label + ' ', { continued: true });
  doc.font('Helvetica').text(body, { paragraphGap: 4, lineGap: 2 });
}
function numberedRich(doc: PDFKit.PDFDocument, label: string, runs: Array<{ text: string; bold?: boolean }>) {
  ensureRoom(doc, 40);
  doc.fillColor(INK).fontSize(10.5);
  doc.font('Helvetica-Bold').text(label + ' ', { continued: true });
  runs.forEach((r, i) => {
    doc.font(r.bold ? 'Helvetica-Bold' : 'Helvetica')
       .text(r.text, { continued: i < runs.length - 1, lineGap: 2, paragraphGap: i === runs.length - 1 ? 4 : 0 });
  });
}
function bulletList(doc: PDFKit.PDFDocument, items: Array<[string, string]>) {
  doc.fillColor(INK).fontSize(10.5);
  items.forEach(([lead, rest]) => {
    ensureRoom(doc, 24);
    const indent = doc.page.margins.left + 14;
    doc.font('Helvetica').text('•', doc.page.margins.left, doc.y, { width: 12, continued: false });
    doc.moveUp();
    doc.font('Helvetica-Bold').text(lead, indent, doc.y, { continued: true, lineGap: 2 });
    doc.font('Helvetica').text(rest, { paragraphGap: 3, lineGap: 2 });
  });
}
function ensureRoom(doc: PDFKit.PDFDocument, needed: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}
function signatureBlocks(doc: PDFKit.PDFDocument, inputs: PartnershipPdfInputs) {
  doc.moveDown(1.2);
  ensureRoom(doc, 180);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text('Signatures');
  doc.moveDown(0.4);
  const gridTop = doc.y;
  const gutter = 24;
  const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right - gutter) / 2;
  const leftX = doc.page.margins.left;
  const rightX = leftX + colWidth + gutter;
  drawSignatureCard(doc, leftX, gridTop, colWidth, {
    label: `For ${inputs.clientName}:`,
    name: inputs.signedByName,
    position: inputs.signedByPosition,
    signatureImage: inputs.signatureImage ?? null,
    fallback: `Signed electronically by ${inputs.signedByName}`,
    date: fmtDate(inputs.effectiveDate),
  });
  drawSignatureCard(doc, rightX, gridTop, colWidth, {
    label: 'For ReceptionMate Ltd:',
    name: 'Daniel Tyldesley',
    position: 'Director',
    signatureImage: null,
    fallback: 'Signed on behalf of ReceptionMate Ltd',
    date: fmtDate(inputs.effectiveDate),
  });
}
function drawSignatureCard(
  doc: PDFKit.PDFDocument, x: number, y: number, width: number,
  s: { label: string; name: string; position: string; signatureImage: string | null; fallback: string; date: string },
) {
  const padding = 14, height = 165;
  doc.save().roundedRect(x, y, width, height, 8).fill('#f8fafc').restore();
  doc.strokeColor(BORDER).lineWidth(0.8).roundedRect(x, y, width, height, 8).stroke();
  let cy = y + padding;
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text(s.label.toUpperCase(), x + padding, cy, { width: width - padding * 2, characterSpacing: 1.1 });
  cy = doc.y + 4;
  doc.fillColor(INK).fontSize(10).font('Helvetica-Bold').text('Name: ', x + padding, cy, { continued: true });
  doc.font('Helvetica').text(s.name);
  cy = doc.y + 2;
  doc.font('Helvetica-Bold').text('Position: ', x + padding, cy, { continued: true });
  doc.font('Helvetica').text(s.position);
  cy = doc.y + 4;
  doc.font('Helvetica-Bold').text('Signature:', x + padding, cy);
  cy = doc.y + 2;
  if (s.signatureImage) {
    try {
      const buf = Buffer.from(s.signatureImage.replace(/^data:image\/png;base64,/, ''), 'base64');
      doc.image(buf, x + padding, cy, { fit: [width - padding * 2, 50] });
    } catch {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(s.fallback, x + padding, cy, { width: width - padding * 2 });
    }
  } else {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(s.fallback, x + padding, cy, { width: width - padding * 2 });
  }
  doc.fillColor(INK).fontSize(10).font('Helvetica-Bold').text('Date: ', x + padding, y + height - padding - 12, { continued: true });
  doc.font('Helvetica').text(s.date);
}
