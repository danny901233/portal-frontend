import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TOTAL_BYTES,
  attachmentS3Key,
  safeAttachmentFilename,
  validateUpload,
  validateTotalSize,
} from './ticketAttachments.js';

// ── validateUpload: one file, on its own ────────────────────────────────────

test('a PDF of ordinary size is accepted', () => {
  const result = validateUpload({
    filename: 'invoice.pdf',
    contentType: 'application/pdf',
    size: 30_000,
  });
  assert.equal(result.ok, true);
});

test('a file over the per-file cap is rejected', () => {
  const result = validateUpload({
    filename: 'huge.pdf',
    contentType: 'application/pdf',
    size: MAX_ATTACHMENT_BYTES + 1,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /too large/i);
});

test('an empty file is rejected', () => {
  const result = validateUpload({ filename: 'empty.pdf', contentType: 'application/pdf', size: 0 });
  assert.equal(result.ok, false);
});

test('an executable is rejected even when it claims to be a PDF', () => {
  // The browser-supplied content type is not evidence. A file named .exe is refused
  // whatever the type header says, because the extension is what the recipient's
  // mail client will act on.
  const result = validateUpload({
    filename: 'payload.exe',
    contentType: 'application/pdf',
    size: 1000,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /not an allowed/i);
});

test('a blocked extension is rejected', () => {
  const result = validateUpload({
    filename: 'script.js',
    contentType: 'application/javascript',
    size: 1000,
  });
  assert.equal(result.ok, false);
});

test('an allowed extension carrying an unrecognised content type is rejected', () => {
  // The extension allowlist is the main gate, but it is not the only one: a type we do
  // not expect for this extension is a mismatch, not a curiosity to wave through.
  const result = validateUpload({
    filename: 'notes.pdf',
    contentType: 'text/html',
    size: 1000,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /says it is/i);
});

test('a generic octet-stream is accepted — browsers send it for legitimate files', () => {
  const result = validateUpload({
    filename: 'invoice.pdf',
    contentType: 'application/octet-stream',
    size: 1000,
  });
  assert.equal(result.ok, true);
});

test('a missing content type falls back to the extension', () => {
  assert.equal(validateUpload({ filename: 'invoice.pdf', contentType: '', size: 1000 }).ok, true);
});

test('a CSV typed as Excel is accepted — Windows reports it that way', () => {
  const result = validateUpload({
    filename: 'export.csv',
    contentType: 'application/vnd.ms-excel',
    size: 1000,
  });
  assert.equal(result.ok, true);
});

test('a spreadsheet is accepted', () => {
  const result = validateUpload({
    filename: 'prices.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 5_000,
  });
  assert.equal(result.ok, true);
});

test('a photo is accepted', () => {
  const result = validateUpload({ filename: 'dash.jpg', contentType: 'image/jpeg', size: 90_000 });
  assert.equal(result.ok, true);
});

test('an extension in a different case is still recognised', () => {
  const result = validateUpload({
    filename: 'INVOICE.PDF',
    contentType: 'application/pdf',
    size: 1000,
  });
  assert.equal(result.ok, true);
});

test('a file with no extension is rejected', () => {
  const result = validateUpload({ filename: 'invoice', contentType: 'application/pdf', size: 1000 });
  assert.equal(result.ok, false);
});

// ── validateTotalSize: the message as a whole ───────────────────────────────

test('a handful of small files is accepted', () => {
  assert.equal(validateTotalSize([1000, 2000, 3000]).ok, true);
});

test('more files than the cap is rejected', () => {
  const sizes = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => 1000);
  const result = validateTotalSize(sizes);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /at most/i);
});

test('files within the per-file cap can still break the message cap', () => {
  // Each file is legal on its own; together they would bounce at Mailgun.
  const each = MAX_ATTACHMENT_BYTES;
  const count = Math.floor(MAX_TOTAL_BYTES / each) + 1;
  const result = validateTotalSize(Array.from({ length: count }, () => each));
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /total/i);
});

test('no files at all is accepted — a reply need not carry one', () => {
  assert.equal(validateTotalSize([]).ok, true);
});

// ── safeAttachmentFilename ─────────────────────────────────────────────────

test('a plain filename is left alone', () => {
  assert.equal(safeAttachmentFilename('invoice.pdf'), 'invoice.pdf');
});

test('directory components are stripped', () => {
  assert.equal(safeAttachmentFilename('../../etc/passwd.pdf'), 'passwd.pdf');
});

test('a Windows path is stripped to its basename', () => {
  assert.equal(safeAttachmentFilename('C:\\Users\\dan\\invoice.pdf'), 'invoice.pdf');
});

test('control characters are removed', () => {
  assert.equal(safeAttachmentFilename('in\u0000voice\n.pdf'), 'invoice.pdf');
});

test('a very long name is truncated but keeps its extension', () => {
  const name = `${'a'.repeat(400)}.pdf`;
  const safe = safeAttachmentFilename(name);
  assert.ok(safe.length <= 120, `expected <=120 chars, got ${safe.length}`);
  assert.ok(safe.endsWith('.pdf'), `expected .pdf ending, got ${safe}`);
});

test('a name that sanitises to nothing falls back to a usable one', () => {
  assert.equal(safeAttachmentFilename('   '), 'attachment');
});

// ── attachmentS3Key ────────────────────────────────────────────────────────

test('the S3 key namespaces by id and keeps the safe filename', () => {
  assert.equal(
    attachmentS3Key('abc123', 'invoice.pdf'),
    'ticket-attachments/abc123/invoice.pdf',
  );
});

test('the S3 key never contains a traversal from the filename', () => {
  const key = attachmentS3Key('abc123', '../../secret.pdf');
  assert.equal(key, 'ticket-attachments/abc123/secret.pdf');
  assert.ok(!key.includes('..'), 'key must not contain ".."');
});
