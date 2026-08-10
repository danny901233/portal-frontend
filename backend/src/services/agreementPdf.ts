// PDF renderer for the signed service agreement.
//
// Uses pdfkit (already a dependency for invoice PDFs). The clause text is
// duplicated here rather than parsed from the HTML — when the contract is
// updated in agreementTemplate.ts, update this file too and bump TEMPLATE_VERSION.

import PDFDocument from 'pdfkit';
import { LICENCE_DETAILS, type LicenceTier } from './agreementTemplate.js';

// Logo lives on GHL CDN — fetched once on first render and cached for the
// lifetime of the process so PDF rendering stays in-memory + fast.
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

export interface AgreementPdfInputs {
  clientName: string;
  setupFeeGbp: number;
  licenceFeeGbp: number;
  centresCount: number;
  licences: LicenceTier[];
  goLiveDate: Date | null;
  effectiveDate: Date | null;
  signedByName: string;
  signedByPosition: string;
  signatureImage?: string | null; // PNG data URL — embedded under the signer name
}

const BRAND = '#3426cf';
const INK = '#0f172a';
const MUTED = '#475569';
const BORDER = '#e2e8f0';

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const FMT_DATE = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

const fmtDate = (d: Date | null): string => (d ? FMT_DATE.format(d) : '—');

/**
 * Renders the full signed agreement to a PDF Buffer.
 * Resolves once the document is finalised.
 */
export async function renderAgreementPdf(inputs: AgreementPdfInputs): Promise<Buffer> {
  const logo = await getLogoBuffer();
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    try {
      drawDocument(doc, inputs, logo);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawDocument(doc: PDFKit.PDFDocument, inputs: AgreementPdfInputs, logo: Buffer | null) {
  const setupFeeStr = inputs.setupFeeGbp > 0 ? GBP.format(inputs.setupFeeGbp) : '£0 (waived)';
  const licenceFeeStr = GBP.format(inputs.licenceFeeGbp);
  const monthlyTotalStr = GBP.format(inputs.licenceFeeGbp * inputs.centresCount);

  // ---------- Header ----------
  if (logo) {
    try {
      // Logo on a brand chip — matches the portal login screen look
      const chipX = doc.page.margins.left;
      const chipY = doc.y;
      const chipH = 44;
      const chipW = 100;
      doc.save().roundedRect(chipX, chipY, chipW, chipH, 8).fill(BRAND).restore();
      doc.image(logo, chipX + 12, chipY + 8, { height: chipH - 16 });
      doc.y = chipY + chipH + 10;
    } catch {
      /* swallow — header is decorative */
    }
  }
  doc.fillColor(BRAND).fontSize(20).font('Helvetica-Bold')
    .text('Software as a Service (SaaS) Agreement', { align: 'left' });
  doc.moveDown(0.3);
  doc.fillColor(MUTED).fontSize(10).font('Helvetica')
    .text(`Date: ${fmtDate(inputs.effectiveDate ?? new Date())}`);
  hr(doc);

  // ---------- Sections ----------
  section(doc, 'Introduction');
  para(doc,
    `This agreement outlines the terms of a strategic partnership between `,
    [
      { text: 'ReceptionMate Ltd', bold: true },
      { text: ' (the "Provider") and ' },
      { text: inputs.clientName, bold: true },
      { text: ' (the "Client") regarding the provision of ReceptionMate’s AI-powered handling services.' },
    ],
  );

  section(doc, '1. Definitions');
  para(doc, 'In this Agreement, the following terms shall have the meanings set out below:');
  bulletList(doc, [
    ['"Services"', ' means the ReceptionMate AI Agent and related software components provided by the Provider on a subscription basis for call answering and enquiry handling.'],
    ['"Platform"', ' means the cloud-based ReceptionMate system made available via web, telephony, and API integration.'],
    ['"Authorised Users"', ' means the Client’s employees or representatives who are permitted to use the Services.'],
    ['"Client Data"', ' means any data, audio, transcripts, or information inputted by the Client or its customers during use of the Services.'],
    ['"Initial Period"', ' means the initial three-month period during which the Services are provided.'],
    ['"Effective Date"', ' means the date of the last signature below.'],
  ]);

  section(doc, '2. Purpose and scope');
  para(doc, 'The Provider agrees to supply, and the Client agrees to subscribe to, the ReceptionMate AI Agent Services for use in managing inbound customer enquiries, bookings, and related communications in connection with the Client’s automotive operations.');

  section(doc, '3. Term');
  numbered(doc, '3.1', `This Agreement shall commence on the agreed "Go Live" date${inputs.goLiveDate ? ` (${fmtDate(inputs.goLiveDate)})` : ''} and continue for a rolling monthly term.`);
  numbered(doc, '3.2', 'After the Initial Period, the Agreement shall renew automatically on a monthly rolling basis unless terminated in accordance with Clause 13.');
  para(doc, 'The Provider shall:');
  alphaList(doc, [
    'Host and maintain access to the ReceptionMate Platform;',
    'Provide AI voice agents for inbound call handling, booking management, and data capture;',
    'Integrate the Platform with the Client’s diary or garage management system, where technically feasible;',
    'Provide support and performance reporting; and',
    'Ensure the Services are available 24 hours a day, subject to scheduled maintenance.',
  ]);

  section(doc, '5. Fees and Payment');
  numberedRich(doc, '5.1', [
    { text: 'Setup Fee.', bold: true },
    { text: ` A setup fee of ` },
    { text: setupFeeStr, bold: true },
    { text: ' is due upon signing this Agreement.' },
  ]);
  numberedRich(doc, '5.2', [
    { text: 'Licence Fee.', bold: true },
    { text: ` The subscription fee shall be ` },
    { text: licenceFeeStr, bold: true },
    { text: ` per month per centre, payable monthly in advance. The number of centres being onboarded under this Agreement is ` },
    { text: String(inputs.centresCount), bold: true },
    { text: ', giving a total monthly subscription of ' },
    { text: monthlyTotalStr, bold: true },
    { text: ' exclusive of VAT.' },
  ]);

  para(doc, 'The licences included under this Agreement are:');
  bulletList(doc,
    inputs.licences.map((l) => [LICENCE_DETAILS[l].name, ' — ' + LICENCE_DETAILS[l].description])
  );

  numberedRich(doc, '5.3', [{ text: 'Usage Charges.', bold: true }]);
  alphaList(doc, [
    'The Automate licence includes 600 minutes of AI-handled calls; £0.25 per connected minute applies after the initial 600 minutes.',
    'The Assist licence includes 400 minutes of AI-handled calls; £0.25 per connected minute applies after the initial 400 minutes. Assist excludes diary integration.',
    'The Connect licence includes 500 AI messaging conversations; £0.25 per message applies thereafter. SMS charges are separate and not included within the messaging allowance; SMS messages are charged at £0.25 per message.',
  ]);
  numbered(doc, '5.4', 'All fees are exclusive of VAT and payable within 14 days of invoice.');

  section(doc, '6. Late Payment');
  numbered(doc, '6.1', 'All invoices issued by the Provider are payable within fourteen (14) days of the invoice date unless otherwise agreed in writing; payment is made by Direct Debit.');
  numbered(doc, '6.2', 'If any undisputed amount remains unpaid after the due date, the Provider may:');
  alphaList(doc, [
    'charge interest on the outstanding sum at a rate of 4% per annum above the Bank of England base rate, accruing daily from the due date until payment is received in full; and',
    'recover from the Client all reasonable costs of collection, including legal fees.',
  ]);
  numbered(doc, '6.3', 'If payment remains outstanding for more than thirty (30) days, the Provider reserves the right, upon giving at least five (5) days’ written notice, to suspend or restrict access to the Services until all overdue amounts are settled.');
  numbered(doc, '6.4', 'Suspension of the Services for non-payment shall not relieve the Client of its obligation to pay the outstanding sums, nor extend any agreed subscription term.');
  numbered(doc, '6.5', 'If payment remains outstanding for more than sixty (60) days, the Provider may treat the non-payment as a material breach and terminate this Agreement in accordance with Clause 13 (Termination).');

  section(doc, '7. Client Obligations');
  para(doc, 'The Client shall:');
  alphaList(doc, [
    'Provide accurate business information, service lists, and booking rules required for setup;',
    'Ensure call routing and telephony settings are correctly configured to forward missed calls to the AI agent;',
    'Provide feedback and performance data during the term;',
    'Comply with applicable laws relating to the use of the Services.',
  ]);

  section(doc, '8. Intellectual Property');
  para(doc, 'All intellectual property rights in the ReceptionMate Platform, AI models, and related software remain the exclusive property of the Provider.');
  para(doc, 'The Client is granted a limited, non-exclusive, non-transferable licence to use the Services for its internal business purposes only.');

  section(doc, '9. Data Protection');
  numbered(doc, '9.1', 'Both Parties shall comply with the UK GDPR and the Data Protection Act 2018.');
  numbered(doc, '9.2', 'The Provider acts as a Data Processor and will process Client Data solely for the purpose of providing the Services.');
  numbered(doc, '9.3', 'The Provider shall implement appropriate technical and organisational measures to safeguard Client Data and shall not share it with third parties except as necessary to deliver the Services or as required by law.');

  section(doc, '10. Confidentiality');
  para(doc, 'Each Party undertakes to keep confidential all proprietary or confidential information disclosed by the other Party and to use such information only for the purposes of fulfilling this Agreement.');

  section(doc, '11. Case Study Consent');
  para(doc, 'The Client grants the Provider permission to reference its name, logo, and monetary results in case studies, marketing materials, and presentations to prospective clients, provided that no personally identifiable information or sensitive data is disclosed.');

  section(doc, '12. Limitation of Liability');
  numbered(doc, '12.1', 'The Provider’s total liability under this Agreement shall not exceed the total fees paid by the Client during the preceding three (3) months.');
  numbered(doc, '12.2', 'Neither Party shall be liable for any indirect, special, or consequential losses including loss of profit, revenue, or goodwill.');

  section(doc, '13. Termination');
  numbered(doc, '13.1', 'Either Party may terminate this Agreement:');
  alphaList(doc, [
    'At any time after the Initial Period of 3 months. After this time, 30 days’ written notice is required.',
  ]);
  numbered(doc, '13.2', 'Either Party may terminate immediately if the other Party commits a material breach that remains unremedied after 10 days of written notice.');

  section(doc, '14. Force Majeure');
  para(doc, 'Neither Party shall be liable for any failure or delay caused by circumstances beyond its reasonable control, including acts of God, network failures, or telecommunications outages.');

  section(doc, '15. Entire Agreement');
  para(doc, 'This Agreement constitutes the entire understanding between the Parties and supersedes all prior proposals or discussions relating to its subject matter.');
  para(doc, 'Any amendment must be made in writing and signed by authorised representatives of both Parties.');

  section(doc, '16. Governing Law and Jurisdiction');
  para(doc, 'This Agreement shall be governed by and construed in accordance with the laws of England and Wales, and the Parties submit to the exclusive jurisdiction of the courts of England and Wales.');

  // ---------- Signatures ----------
  signatureBlocks(doc, inputs);
}

// ---------- low-level drawing helpers ----------

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

function para(doc: PDFKit.PDFDocument, leading: string, runs?: Array<{ text: string; bold?: boolean }>) {
  ensureRoom(doc, 40);
  doc.fillColor(INK).fontSize(10.5);
  if (!runs || runs.length === 0) {
    doc.font('Helvetica').text(leading, { paragraphGap: 4, lineGap: 2 });
    return;
  }
  doc.font('Helvetica').text(leading, { continued: true, lineGap: 2 });
  runs.forEach((r, i) => {
    doc.font(r.bold ? 'Helvetica-Bold' : 'Helvetica')
       .text(r.text, { continued: i < runs.length - 1, lineGap: 2, paragraphGap: i === runs.length - 1 ? 4 : 0 });
  });
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

function alphaList(doc: PDFKit.PDFDocument, items: string[]) {
  doc.fillColor(INK).fontSize(10.5);
  items.forEach((body, i) => {
    ensureRoom(doc, 24);
    const indent = doc.page.margins.left + 22;
    const label = `(${String.fromCharCode('a'.charCodeAt(0) + i)})`;
    doc.font('Helvetica').text(label, doc.page.margins.left + 4, doc.y, { width: 18, continued: false });
    doc.moveUp();
    doc.font('Helvetica').text(body, indent, doc.y, { paragraphGap: 3, lineGap: 2 });
  });
}

function ensureRoom(doc: PDFKit.PDFDocument, needed: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
  }
}

function signatureBlocks(doc: PDFKit.PDFDocument, inputs: AgreementPdfInputs) {
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
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  s: { label: string; name: string; position: string; signatureImage: string | null; fallback: string; date: string },
) {
  const padding = 14;
  const height = 165;
  // Card background
  doc.save();
  doc.roundedRect(x, y, width, height, 8).fill('#f8fafc').stroke();
  doc.restore();
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
      const base64 = s.signatureImage.replace(/^data:image\/png;base64,/, '');
      const buf = Buffer.from(base64, 'base64');
      doc.image(buf, x + padding, cy, { fit: [width - padding * 2, 50] });
      cy = cy + 52;
    } catch {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(s.fallback, x + padding, cy, { width: width - padding * 2 });
      cy = doc.y + 4;
    }
  } else {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(s.fallback, x + padding, cy, { width: width - padding * 2 });
    cy = doc.y + 4;
  }

  doc.fillColor(INK).fontSize(10).font('Helvetica-Bold').text('Date: ', x + padding, y + height - padding - 12, { continued: true });
  doc.font('Helvetica').text(s.date);
}
