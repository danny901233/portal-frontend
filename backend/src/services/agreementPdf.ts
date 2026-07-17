// PDF renderer for the signed service agreement.
//
// Uses pdfkit (already a dependency for invoice PDFs). The clause text is NOT duplicated here —
// it is rendered from the agreement HTML, which is the single source of the contract's words.
//
// It used to be duplicated, with a comment instructing whoever edited the contract to update
// both files. They didn't, and nobody noticed: the HTML came to say a 3-month Proof Period then
// a 12-month minimum term with no termination for convenience, while this file still said "a
// rolling monthly term" that either party could leave after 3 months. Customers signed one
// contract and were emailed another — and the PDF is the copy they keep.
//
// Where possible the caller passes the SIGNED SNAPSHOT, so the PDF is literally the document
// they agreed to. Absent one, the HTML is generated from the same canonical template.

import PDFDocument from 'pdfkit';
import { LICENCE_DETAILS, renderAgreementHtml, type LicenceTier } from './agreementTemplate.js';
import { blocksFromAgreementHtml, type Block, type Run } from './agreementBlocks.js';

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
  messagingFeeGbp?: number;
  centresCount: number;
  licences: LicenceTier[];
  goLiveDate: Date | null;
  effectiveDate: Date | null;
  signedByName: string;
  signedByPosition: string;
  signatureImage?: string | null; // PNG data URL — embedded under the signer name
  /**
   * The exact HTML the customer signed (Agreement.templateSnapshot). When present the PDF renders
   * THIS, so the emailed copy is the document they actually agreed to — not a re-render that
   * might reflect a template edited since. Absent, the HTML is generated from the same template.
   */
  bodyHtml?: string | null;
  freeTrialDays?: number | null;
  freeUntilBookings?: number | null;
  // Audit trail, printed on the final page. All optional: older agreements pre-date the tracking
  // and should print "not recorded" rather than pretend to know.
  audit?: {
    sentToEmail?: string | null;
    sentToSms?: string | null;
    sentAt?: Date | null;
    firstViewedAt?: Date | null;
    lastViewedAt?: Date | null;
    viewCount?: number | null;
    viewedFromIp?: string | null;
    viewedUserAgent?: string | null;
    signedFromIp?: string | null;
    signedUserAgent?: string | null;
    signerEmail?: string | null;
    agreementId?: string | null;
    templateVersion?: string | null;
  } | null;
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
      if (inputs.audit) drawAuditPage(doc, inputs);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawDocument(doc: PDFKit.PDFDocument, inputs: AgreementPdfInputs, logo: Buffer | null) {
  const setupFeeStr = inputs.setupFeeGbp > 0 ? GBP.format(inputs.setupFeeGbp) : '£0 (waived)';
  // Mirrors the HTML template: voice + Connect are separate per-branch lines, as billed.
  const messagingFee = inputs.messagingFeeGbp ?? 0;
  const licenceFeeStr = GBP.format(inputs.licenceFeeGbp);
  const messagingFeeStr = GBP.format(messagingFee);
  const monthlyTotalStr = GBP.format((inputs.licenceFeeGbp + messagingFee) * inputs.centresCount);

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
  // ---------- the contract itself ----------
  // Rendered from the HTML rather than retyped here. This is the whole point: one copy of the
  // words. Prefer the signed snapshot; otherwise generate from the canonical template.
  const bodyHtml = inputs.bodyHtml || renderAgreementHtml({
    clientName: inputs.clientName,
    setupFeeGbp: inputs.setupFeeGbp,
    licenceFeeGbp: inputs.licenceFeeGbp,
    messagingFeeGbp: inputs.messagingFeeGbp,
    freeTrialDays: inputs.freeTrialDays,
    freeUntilBookings: inputs.freeUntilBookings,
    centresCount: inputs.centresCount,
    licences: inputs.licences,
    goLiveDate: inputs.goLiveDate,
    effectiveDate: inputs.effectiveDate,
    signedByName: inputs.signedByName,
    signedByPosition: inputs.signedByPosition,
  });
  drawBlocks(doc, blocksFromAgreementHtml(bodyHtml));

  // ---------- Signatures ----------
  signatureBlocks(doc, inputs);
}

// ---------- rendering the parsed contract ----------

/** Draw a run sequence as one paragraph, preserving bold/italic exactly as the HTML has it. */
function richPara(doc: PDFKit.PDFDocument, runs: Run[]) {
  if (!runs.length) return;
  ensureRoom(doc, 40);
  doc.fillColor(INK).fontSize(10.5);
  runs.forEach((r, i) => {
    const last = i === runs.length - 1;
    doc.font(r.bold ? 'Helvetica-Bold' : r.italic ? 'Helvetica-Oblique' : 'Helvetica')
       .text(r.text, { continued: !last, lineGap: 2, paragraphGap: last ? 4 : 0 });
  });
}

function richList(doc: PDFKit.PDFDocument, items: Run[][], marker: (i: number) => string) {
  doc.fillColor(INK).fontSize(10.5);
  items.forEach((runs, i) => {
    ensureRoom(doc, 24);
    const indent = doc.page.margins.left + 22;
    doc.font('Helvetica').text(marker(i), doc.page.margins.left + 4, doc.y, { width: 18, continued: false });
    doc.moveUp();
    // First run starts at the indent; the rest continue inline.
    runs.forEach((r, j) => {
      const last = j === runs.length - 1;
      const font = r.bold ? 'Helvetica-Bold' : r.italic ? 'Helvetica-Oblique' : 'Helvetica';
      if (j === 0) doc.font(font).text(r.text, indent, doc.y, { continued: !last, lineGap: 2, paragraphGap: last ? 3 : 0 });
      else doc.font(font).text(r.text, { continued: !last, lineGap: 2, paragraphGap: last ? 3 : 0 });
    });
  });
}

function drawBlocks(doc: PDFKit.PDFDocument, blocks: Block[]) {
  for (const b of blocks) {
    switch (b.t) {
      case 'heading': section(doc, b.text); break;
      case 'para': richPara(doc, b.runs); break;
      case 'bullets': richList(doc, b.items, () => '•'); break;
      case 'alpha': richList(doc, b.items, (i) => `(${String.fromCharCode(97 + i)})`); break;
    }
  }
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


/**
 * Final page: the audit trail. Deliberately plain and dense — this page exists to be read in a
 * dispute, not to look nice. Anything we don't know prints "Not recorded" rather than being
 * silently omitted, so a gap is visible instead of invisible.
 */
function drawAuditPage(doc: PDFKit.PDFDocument, inputs: AgreementPdfInputs) {
  const a = inputs.audit!;
  doc.addPage();

  const fmt = (d?: Date | null) =>
    d
      ? new Date(d).toLocaleString('en-GB', {
          day: '2-digit', month: 'long', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          timeZone: 'Europe/London',
        }) + ' (UK time)'
      : 'Not recorded';
  const val = (v?: string | number | null) => (v === null || v === undefined || v === '' ? 'Not recorded' : String(v));

  doc.fillColor(BRAND).fontSize(16).font('Helvetica-Bold').text('Signature audit trail');
  doc.moveDown(0.3);
  doc
    .fillColor(MUTED)
    .fontSize(9)
    .font('Helvetica')
    .text(
      'An automatically generated record of how this agreement was delivered, opened and signed. ' +
        'Times are UK local. IP addresses are as seen by our servers at the time of each event.',
      { width: 483 },
    );
  doc.moveDown(1);

  const rows: [string, string][] = [
    ['Agreement reference', val(a.agreementId)],
    ['Template version', val(a.templateVersion)],
    ['—1', ''],
    ['Sent to', val(a.sentToEmail)],
    ['Also texted to', val(a.sentToSms)],
    ['Sent at', fmt(a.sentAt)],
    ['—2', ''],
    ['First opened', fmt(a.firstViewedAt)],
    ['Opened from IP', val(a.viewedFromIp)],
    ['Opened using', val(a.viewedUserAgent)],
    ['Last opened', fmt(a.lastViewedAt)],
    ['Times opened', val(a.viewCount)],
    ['—3', ''],
    ['Signed by', `${inputs.signedByName}${inputs.signedByPosition ? ', ' + inputs.signedByPosition : ''}`],
    ['Signer email', val(a.signerEmail)],
    ['Signed at', fmt(inputs.effectiveDate)],
    ['Signed from IP', val(a.signedFromIp)],
    ['Signed using', val(a.signedUserAgent)],
  ];

  const left = 56;
  const labelW = 130;
  const valueW = 353;
  let y = doc.y;

  for (const [label, value] of rows) {
    if (label.startsWith('—')) {
      doc.moveTo(left, y + 4).lineTo(left + labelW + valueW, y + 4).strokeColor(BORDER).lineWidth(0.5).stroke();
      y += 12;
      continue;
    }
    doc.fillColor(MUTED).fontSize(9).font('Helvetica-Bold').text(label, left, y, { width: labelW });
    const h = doc.heightOfString(value, { width: valueW, align: 'left' });
    doc.fillColor(INK).fontSize(9).font('Helvetica').text(value, left + labelW, y, { width: valueW });
    y += Math.max(h, 12) + 6;
  }

  doc.moveDown(1);
  doc
    .fillColor(MUTED)
    .fontSize(8)
    .font('Helvetica-Oblique')
    .text(
      'This page is generated from ReceptionMate\'s records at the time the signed copy was issued. ' +
        'The agreement text reproduced in this document is the exact version presented to the signer, ' +
        'captured at the moment of signing.',
      left,
      y + 8,
      { width: labelW + valueW },
    );
}
