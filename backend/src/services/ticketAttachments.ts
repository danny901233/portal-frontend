// Files staff attach to an outbound ticket email.
//
// Upload is deliberately its own step, decoupled from sending. A file is uploaded, validated and
// parked in S3 with no ticket entry attached to it; the reply or compose request then names the
// ids it wants. That ordering is what lets the "New email" box carry attachments at all — there
// is no ticket to hang them on until the message is actually sent.
//
// The validation half of this module is pure and tested. The S3 and Prisma half is not: it is
// thin, and its failure modes are network ones that a unit test would only mock.

import { randomUUID } from 'crypto';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { prisma } from '../db.js';
import type { EmailAttachment } from '../utils/email.js';

/** Per file. Mailgun's hard limit is 25MB for the whole message. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Per message, across every file on it. Comfortably inside Mailgun's 25MB so the
 *  base64 inflation of a multipart body cannot push a legal set over the edge. */
export const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;

/** How long a download link stays good. Short, because the link needs no auth once issued. */
const DOWNLOAD_URL_TTL_SECONDS = 600;

/** Unclaimed uploads older than this are swept. An abandoned compose box should not
 *  leave objects in the bucket for ever. */
export const STAGED_ATTACHMENT_TTL_HOURS = 24;

const KEY_PREFIX = 'ticket-attachments';

/**
 * What staff may send.
 *
 * An allowlist, not a blocklist: this is mail leaving our domain under our sending reputation,
 * and the set of things a garage actually needs from us is small and knowable. Both the
 * extension and the content type must be allowed — the browser-supplied type is a hint, while
 * the extension is what the recipient's mail client will act on, so neither alone is enough.
 */
const ALLOWED: Record<string, readonly string[]> = {
  pdf: ['application/pdf'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  heic: ['image/heic', 'image/heif'],
  txt: ['text/plain'],
  // Windows with Excel installed reports a .csv as an Excel type, so it is listed here
  // too — rejecting it would refuse the commonest export a garage sends us.
  csv: ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};

/**
 * Types that carry no information, which browsers send for plenty of legitimate files.
 * Accepted on the strength of the extension; anything else must match the extension.
 */
const GENERIC_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/download',
]);

export type Validation = { ok: true } | { ok: false; error: string };

const extensionOf = (filename: string): string => {
  const base = safeAttachmentFilename(filename);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
};

const prettyMb = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`;

/** One file, judged on its own. */
export function validateUpload(file: {
  filename: string;
  contentType: string;
  size: number;
}): Validation {
  if (file.size <= 0) return { ok: false, error: 'That file is empty.' };
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `That file is too large — ${prettyMb(file.size)}, and the limit is ${prettyMb(MAX_ATTACHMENT_BYTES)} per file.`,
    };
  }

  const ext = extensionOf(file.filename);
  if (!ext) return { ok: false, error: 'That file has no extension, so we cannot tell what it is.' };

  const allowedTypes = ALLOWED[ext];
  if (!allowedTypes) {
    return {
      ok: false,
      error: `.${ext} is not an allowed attachment type. Allowed: ${Object.keys(ALLOWED).join(', ')}.`,
    };
  }

  // The type must either match the extension or carry no information at all. An earlier
  // version only refused a type belonging to some OTHER allowed extension, which let
  // anything unrecognised — text/html on a .pdf, say — through on the extension alone.
  const type = (file.contentType || '').split(';')[0].trim().toLowerCase();
  if (!GENERIC_TYPES.has(type) && !allowedTypes.includes(type)) {
    return { ok: false, error: `That file says it is ${type} but is named .${ext}.` };
  }

  return { ok: true };
}

/** The message as a whole: how many files, and how much in total. */
export function validateTotalSize(sizes: number[]): Validation {
  if (sizes.length > MAX_ATTACHMENTS) {
    return { ok: false, error: `You can attach at most ${MAX_ATTACHMENTS} files to one message.` };
  }
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total > MAX_TOTAL_BYTES) {
    return {
      ok: false,
      error: `Those files come to ${prettyMb(total)} in total, and the limit is ${prettyMb(MAX_TOTAL_BYTES)} per message.`,
    };
  }
  return { ok: true };
}

/**
 * A filename safe to put in an S3 key and an email header.
 *
 * Takes the basename (both separators — an upload from Windows arrives with backslashes),
 * drops control characters, and caps the length while keeping the extension, since the
 * extension is the part the recipient's mail client reads.
 */
export function safeAttachmentFilename(name: string): string {
  const basename = (name || '')
    .split(/[/\\]/)
    .pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = basename.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment';

  const MAX = 120;
  if (cleaned.length <= MAX) return cleaned;

  const dot = cleaned.lastIndexOf('.');
  if (dot <= 0) return cleaned.slice(0, MAX);
  const ext = cleaned.slice(dot);          // includes the dot
  const stem = cleaned.slice(0, dot);
  return `${stem.slice(0, Math.max(1, MAX - ext.length))}${ext}`;
}

/** Where the bytes live. The id namespaces it, so two files of the same name never collide. */
export function attachmentS3Key(id: string, filename: string): string {
  return `${KEY_PREFIX}/${id}/${safeAttachmentFilename(filename)}`;
}

// ── S3 + Prisma ────────────────────────────────────────────────────────────

const bucket = () =>
  process.env.S3_ATTACHMENT_BUCKET || process.env.S3_MEDIA_BUCKET || process.env.S3_BUCKET || 'receptionmate-recordings';

/**
 * Explicit credentials, exactly as chatMedia.ts and the WhatsApp media upload do.
 *
 * NOT the default credential chain: on the box that resolves to a deliberately narrow IAM
 * user with read-only access to this bucket, so a client built without credentials can
 * presign and fetch but cannot write. The S3_* key is the one with PutObject.
 */
const s3 = () => {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.S3_REGION || process.env.AWS_REGION || 'eu-west-2';
  return new S3Client({
    region,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
};

/**
 * Store an uploaded file and record it as staged — belonging to no entry yet.
 *
 * Validation is the caller's job; this assumes an already-validated file so the route can
 * answer with a clean 400 before any bytes reach S3.
 */
export async function stageAttachment(args: {
  filename: string;
  contentType: string;
  bytes: Buffer;
  uploadedByUserId: string;
}): Promise<{ id: string; filename: string; size: number; contentType: string }> {
  const id = randomUUID();
  const filename = safeAttachmentFilename(args.filename);
  const key = attachmentS3Key(id, filename);

  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: args.bytes,
      ContentType: args.contentType,
    }),
  );

  const row = await prisma.ticketAttachment.create({
    data: {
      id,
      s3Key: key,
      filename,
      contentType: args.contentType,
      size: args.bytes.length,
      uploadedByUserId: args.uploadedByUserId,
    },
    select: { id: true, filename: true, size: true, contentType: true },
  });
  return row;
}

/** The staged rows for these ids, for the user who staged them. */
export async function loadStagedAttachments(ids: string[], uploadedByUserId: string) {
  if (!ids.length) return [];
  return prisma.ticketAttachment.findMany({
    // Only unclaimed rows, and only this user's: an id is a bare uuid, and reusing one
    // already sent on another ticket would attach a file to a conversation it has no
    // business being in.
    where: { id: { in: ids }, ticketEntryId: null, uploadedByUserId },
    select: { id: true, s3Key: true, filename: true, size: true, contentType: true },
  });
}

/**
 * Files already attached to one entry.
 *
 * Needed when a draft becomes the sent reply: its attachments were claimed when the draft was
 * created, so they are no longer staged, and loading only staged ones would send the approved
 * message without the files it was written to carry.
 */
export async function loadEntryAttachments(ticketEntryId: string) {
  return prisma.ticketAttachment.findMany({
    where: { ticketEntryId },
    select: { id: true, s3Key: true, filename: true, size: true, contentType: true },
    orderBy: { createdAt: 'asc' },
  });
}

/** Pull the bytes back out of S3 and shape them for the mailer. */
export async function toEmailAttachments(
  rows: Array<{ s3Key: string; filename: string; contentType: string }>,
): Promise<EmailAttachment[]> {
  const out: EmailAttachment[] = [];
  for (const row of rows) {
    const obj = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: row.s3Key }));
    const bytes = Buffer.from(await obj.Body!.transformToByteArray());
    out.push({ filename: row.filename, content: bytes, contentType: row.contentType });
  }
  return out;
}

/** Hand the staged rows to the entry that sent them, so the timeline can show them. */
export async function claimAttachments(ids: string[], ticketEntryId: string): Promise<number> {
  if (!ids.length) return 0;
  const { count } = await prisma.ticketAttachment.updateMany({
    where: { id: { in: ids }, ticketEntryId: null },
    data: { ticketEntryId },
  });
  return count;
}

/** A short-lived link to one attachment. */
export async function presignAttachment(id: string): Promise<{ url: string; filename: string } | null> {
  const row = await prisma.ticketAttachment.findUnique({
    where: { id },
    select: { s3Key: true, filename: true },
  });
  if (!row) return null;
  const url = await getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: row.s3Key,
      // So a click downloads the file under its own name rather than opening a uuid.
      ResponseContentDisposition: `attachment; filename="${row.filename.replace(/"/g, '')}"`,
    }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );
  return { url, filename: row.filename };
}

/**
 * Delete uploads that were staged and never sent.
 *
 * Called from the scheduler. S3 first: a row without its object is a broken link, while an
 * object without its row is invisible and costs pennies, so the harmless failure is the one
 * to prefer if this stops halfway.
 */
export async function sweepStagedAttachments(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STAGED_ATTACHMENT_TTL_HOURS * 3600 * 1000);
  const stale = await prisma.ticketAttachment.findMany({
    where: { ticketEntryId: null, createdAt: { lt: cutoff } },
    select: { id: true, s3Key: true },
  });
  if (!stale.length) return 0;

  for (const row of stale) {
    try {
      await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: row.s3Key }));
    } catch (err) {
      console.error(`[TICKET_ATTACHMENTS] could not delete ${row.s3Key}:`, err);
    }
  }
  const { count } = await prisma.ticketAttachment.deleteMany({
    where: { id: { in: stale.map((r) => r.id) } },
  });
  console.log(`[TICKET_ATTACHMENTS] swept ${count} unsent upload(s)`);
  return count;
}
