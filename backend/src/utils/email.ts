import nodemailer from 'nodemailer';
import type { TranscriptEntry } from './types.js';
import { prisma } from '../db.js';
import { isOnboardingEmail, noteOnboardingEmail } from '../services/onboardingCrmNote.js';

/** What a transport reports back. `providerMessageId` is Mailgun's id, which its webhooks
 *  later post against to turn "sent" into "delivered" or "bounced". */
interface SendOutcome {
  sent: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer | string;       // Buffer, or base64-encoded string when `encoding` is set
  encoding?: 'base64';
  contentType?: string;           // e.g. 'application/pdf'
}

interface EmailOptions {
  to: string[];
  cc?: string[];
  /** Where replies should land. Without it they go to MAILGUN_FROM, which is noreply@ — fine for
   *  a receipt, wrong for anything that asks the reader to reply. */
  replyTo?: string;
  /** Visible sender. Setting Reply-To fixes the routing but not the impression: a reader who sees
   *  noreply@ in the From line will not reply whatever the headers say. Defaults to MAILGUN_FROM. */
  from?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];

  // --- Audit tagging. All optional so existing callers keep working untouched; anything
  // that omits `template` is logged as "unknown", which is searchable, so the senders still
  // to be tagged show up rather than hiding. ---
  /** Kind of email, e.g. "abandoned_checkout_1", "arrears_warning", "password_reset". */
  template?: string;
  /** Links the row to a customer so their mail can be listed on their own page. */
  garageId?: string | null;
  businessId?: string | null;
  userId?: string | null;
  pendingSignupId?: string | null;

  // Arbitrary RFC5322 headers to include on the outbound message. Used by the
  // Support Hub reply flow (Phase 1) to set Message-Id / In-Reply-To /
  // References so replies from staff land in the customer's original email
  // thread rather than starting a new one. Values are passed through unaltered
  // — the caller owns escaping (angle brackets on message ids, etc.).
  headers?: Record<string, string>;

  /** Which Mailgun sending domain to send through, overriding MAILGUN_DOMAIN.
   *
   *  The domain is not cosmetic: it is what signs the message (DKIM d=) and what
   *  the return path is stamped with, so it is what a mail client shows when it
   *  decides to display the authenticated sender rather than the From header.
   *  Support mail sent through `noreply.receptionmate.co.uk` surfaced in Outlook
   *  as `hello=receptionmate.co.uk@noreply.receptionmate.co.uk` — telling someone
   *  who had just written in that they were talking to a no-reply address.
   *
   *  So support mail goes through `support.`, and `noreply.` is left to the mail
   *  that genuinely does not want a reply. */
  domain?: string;
}

/**
 * Where a reply goes when a template asks for one.
 *
 * Most portal mail is genuinely no-reply — password resets, campaign sends,
 * notifications — and a reply to those SHOULD bounce. That is what the sending
 * address is for, and nothing here changes it.
 *
 * But several templates end with "just reply to this email", and they send from
 * `noreply@` too, so that invitation goes nowhere: the customer replies, gets a
 * bounce, and we never learn they tried. The worst of them is the arrears notice
 * — someone locked out, replying to say they have already paid, silently refused.
 *
 * Setting Reply-To rather than From keeps the visible sender as `noreply@`, so
 * the message still reads as automated, while the reply lands at `hello@` and
 * becomes a ticket. `abandonedCheckout.ts` reached the same conclusion first and
 * fixed it with `from`; this is the lighter version for templates where the
 * automated From line is still the honest one.
 *
 * Apply it to any template whose copy invites a reply. Do NOT apply it blanket:
 * out-of-office bounces from a campaign send would each open a ticket.
 */
export const SUPPORT_REPLY_TO = process.env.SUPPORT_REPLY_TO || 'hello@receptionmate.co.uk';

/** Sending domain for support conversations — see `EmailOptions.domain`. Anything
 *  a customer might reply to should go through this, never `noreply.`. */
export const SUPPORT_MAILGUN_DOMAIN =
  process.env.SUPPORT_MAILGUN_DOMAIN || 'support.receptionmate.co.uk';

const getMailgunConfig = () => {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const from = process.env.MAILGUN_FROM;
  const apiBase = (process.env.MAILGUN_API_BASE || 'https://api.mailgun.net').replace(/\/$/, '');

  if (!apiKey || !domain || !from) {
    console.error('Email configuration missing. Set MAILGUN_API_KEY, MAILGUN_DOMAIN, and MAILGUN_FROM environment variables.');
    return null;
  }

  return { apiKey, domain, from, apiBase };
};

const getO365Config = () => {
  const host = process.env.O365_SMTP_HOST || 'smtp.office365.com';
  const port = Number(process.env.O365_SMTP_PORT || 587);
  const user = process.env.O365_SMTP_USER;
  const pass = process.env.O365_SMTP_PASS;
  const from = process.env.O365_FROM || user;

  if (!user || !pass || !from) {
    return null;
  }

  return { host, port, user, pass, from };
};

const sendViaMailgun = async (options: EmailOptions, config: ReturnType<typeof getMailgunConfig>): Promise<SendOutcome> => {
  if (!config) {
    return { sent: false };
  }

  // Mailgun accepts either application/x-www-form-urlencoded (no attachments)
  // or multipart/form-data (with attachments). Use multipart whenever
  // attachments are present so the file bytes ride through correctly.
  const hasAttachments = (options.attachments?.length ?? 0) > 0;

  let body: BodyInit;
  // A Mailgun sending key is scoped to ONE domain, so sending through a second
  // domain needs its own key. Without it Mailgun answers 401 Forbidden and the
  // message is simply never sent — which for an auto-acknowledgement means the
  // customer hears nothing at all. A slightly wrong return path is a much smaller
  // problem than silence, so fall back to the default domain rather than fail.
  let sendDomain = options.domain || config.domain;
  let sendKey = config.apiKey;
  if (options.domain && options.domain !== config.domain) {
    const scopedKey = process.env.SUPPORT_MAILGUN_API_KEY;
    if (scopedKey) {
      sendKey = scopedKey;
    } else {
      console.warn(
        `[EMAIL] SUPPORT_MAILGUN_API_KEY not set — sending via ${config.domain} instead of ${options.domain}. ` +
        'Return path will read the default domain until a sending key for it is configured.',
      );
      sendDomain = config.domain;
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`api:${sendKey}`).toString('base64')}`,
  };

  // Mailgun API: passing a custom RFC5322 header X on the outbound message
  // is done by prefixing the form field with "h:", e.g. "h:In-Reply-To".
  const customHeaderEntries = Object.entries(options.headers ?? {});

  if (hasAttachments) {
    const form = new FormData();
    form.set('from', options.from || config.from);
    form.set('to', options.to.join(', '));
    if (options.cc?.length) form.set('cc', options.cc.join(', '));
    if (options.replyTo) form.set('h:Reply-To', options.replyTo);
    form.set('subject', options.subject);
    form.set('text', options.text);
    form.set('html', options.html);
    for (const [name, value] of customHeaderEntries) {
      form.set(`h:${name}`, value);
    }
    for (const att of options.attachments!) {
      const buf = att.encoding === 'base64' && typeof att.content === 'string'
        ? Buffer.from(att.content, 'base64')
        : (att.content as Buffer);
      const blob = new Blob([new Uint8Array(buf)], { type: att.contentType ?? 'application/octet-stream' });
      form.append('attachment', blob, att.filename);
    }
    body = form;
    // FormData will set its own multipart Content-Type with the boundary
  } else {
    const form = new URLSearchParams();
    form.set('from', options.from || config.from);
    form.set('to', options.to.join(', '));
    if (options.cc?.length) form.set('cc', options.cc.join(', '));
    if (options.replyTo) form.set('h:Reply-To', options.replyTo);
    form.set('subject', options.subject);
    form.set('text', options.text);
    form.set('html', options.html);
    for (const [name, value] of customHeaderEntries) {
      form.set(`h:${name}`, value);
    }
    body = form.toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const response = await fetch(`${config.apiBase}/v3/${sendDomain}/messages`, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error('Failed to send email via Mailgun:', response.status, errorBody);
    return { sent: false, error: `mailgun ${response.status}: ${errorBody.slice(0, 500)}` };
  }

  // Mailgun answers {"id": "<20260921...@domain>", "message": "Queued. Thank you."}. The id
  // is what its delivery webhooks key against, so a parse failure here costs us the status
  // trail but must never fail the send.
  let providerMessageId: string | undefined;
  try {
    const parsed = (await response.json()) as { id?: string };
    providerMessageId = parsed?.id;
  } catch {
    /* body already consumed or not JSON — the mail still went */
  }

  return { sent: true, providerMessageId };
};

const sendViaO365 = async (options: EmailOptions, config: ReturnType<typeof getO365Config>): Promise<SendOutcome> => {
  if (!config) {
    return { sent: false };
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    requireTLS: true,
  });

  const info = await transport.sendMail({
    replyTo: options.replyTo,
    ...(options.from ? { from: options.from } : {}),
    from: config.from,
    to: options.to.join(', '),
    ...(options.cc?.length ? { cc: options.cc.join(', ') } : {}),
    subject: options.subject,
    text: options.text,
    html: options.html,
    // nodemailer's `headers` accepts a plain object of extra RFC5322 headers.
    headers: options.headers,
    attachments: options.attachments?.map((a) => ({
      filename: a.filename,
      content: a.encoding === 'base64' && typeof a.content === 'string'
        ? Buffer.from(a.content, 'base64')
        : a.content,
      contentType: a.contentType,
    })),
  });

  return { sent: true, providerMessageId: info?.messageId };
};

/** Records the send. Never throws: an audit-trail failure must not lose a customer email,
 *  so a broken write is logged loudly and swallowed. */
const recordEmail = async (
  options: EmailOptions,
  transport: string,
  outcome: SendOutcome,
): Promise<void> => {
  try {
    await prisma.emailLog.create({
      data: {
        to: options.to,
        cc: options.cc ?? [],
        subject: options.subject,
        template: options.template ?? 'unknown',
        garageId: options.garageId ?? null,
        businessId: options.businessId ?? null,
        userId: options.userId ?? null,
        pendingSignupId: options.pendingSignupId ?? null,
        transport,
        providerMessageId: outcome.providerMessageId ?? null,
        status: outcome.sent ? 'sent' : 'failed',
        error: outcome.error ?? null,
        failedAt: outcome.sent ? null : new Date(),
      },
    });
  } catch (error) {
    console.error('[EMAIL_LOG] failed to record email send:', error);
  }

  // A HighLevel timeline note, for ONBOARDING emails only. HighLevel is the sales pipeline and
  // owns a garage until it goes live; the portal is the CRM after that. The allow-list inside
  // noteOnboardingEmail is what keeps this useful — hooking every email from here would push
  // call summaries, arrears warnings and ticket replies into the timeline and bury the six that
  // describe an onboarding.
  //
  // Deliberately not awaited, and it swallows its own errors. The customer's email has already
  // been sent by the time we get here; a slow or failing CRM must not delay this function or
  // surface as a failed send.
  if (outcome.sent && isOnboardingEmail(options.template)) {
    void noteOnboardingEmail({
      template: options.template,
      subject: options.subject,
      to: options.to,
      garageId: options.garageId,
      businessId: options.businessId,
    });
  }
};

export const sendEmail = async (options: EmailOptions): Promise<boolean> => {
  const mailgunConfig = getMailgunConfig();
  const o365Config = getO365Config();

  if (!mailgunConfig && !o365Config) {
    console.warn('Email configuration missing. Configure Mailgun or O365 SMTP to enable sending.');
    await recordEmail(options, 'none', { sent: false, error: 'no transport configured' });
    return false;
  }

  let lastError: string | undefined;

  if (mailgunConfig) {
    try {
      const outcome = await sendViaMailgun(options, mailgunConfig);
      if (outcome.sent) {
        console.log(`Email sent successfully via Mailgun to: ${options.to.join(', ')}`);
        await recordEmail(options, 'mailgun', outcome);
        return true;
      }
      lastError = outcome.error;
      console.warn('Mailgun send failed, attempting O365 fallback.');
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error('Failed to send email via Mailgun:', error);
      console.warn('Attempting O365 fallback.');
    }
  }

  if (o365Config) {
    try {
      const outcome = await sendViaO365(options, o365Config);
      if (outcome.sent) {
        console.log(`Email sent successfully via O365 to: ${options.to.join(', ')}`);
        await recordEmail(options, 'o365', outcome);
        return true;
      }
      lastError = outcome.error ?? lastError;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error('Failed to send email via O365:', error);
      await recordEmail(options, 'o365', { sent: false, error: lastError });
      return false;
    }
  }

  console.warn('Email send failed and no fallback succeeded.');
  await recordEmail(options, mailgunConfig ? 'mailgun' : 'o365', { sent: false, error: lastError });
  return false;
};

interface CallSummaryEmailData {
  branchName: string;
  summary: string;
  transcript: TranscriptEntry[];
  durationSeconds: number;
  callType: string;
  customerName?: string | null;
  customerPhone?: string | null;
  registrationNumber?: string | null;
  confirmedBooking?: boolean;
  capturedRevenue?: number | null;
  createdAt: string;
  bookingDate?: string | null;
  priceQuoted?: number | null;
}

const formatDuration = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }
  
  return `${minutes}m ${remainingSeconds}s`;
};

const formatTranscript = (transcript: TranscriptEntry[]): string => {
  return transcript
    .map((entry) => `${entry.speaker}: ${entry.text}`)
    .join('\n\n');
};

// ── Shared body pieces for brandedEmailShell ────────────────────────────────────────────────
// Every transactional email is the same four shapes: a title under the logo band, a card of
// label/value facts, some prose, and one button. These exist because five emails used to carry
// their own navy scaffold (#09203c page, #1a3a52 card, white-on-navy text) which had drifted
// away from the portal and the marketing site. Each helper returns a complete <tr>, so a body
// is a list of them concatenated and handed to brandedEmailShell.
const RM_INK = '#0f172a';     // body copy
const RM_MUTED = '#64748b';   // labels, secondary copy
const RM_FAINT = '#8b90b0';   // section eyebrows, footnotes
const RM_LINE = '#e9eaf5';    // hairlines and card borders
const RM_WASH = '#f7f7fb';    // card fill
const RM_GOOD = '#10b981';    // money captured, confirmations
const RM_WARN = '#b45309';    // amber-700: readable on white, unlike #fbbf24
const RM_BAD = '#dc2626';

/** Escape anything a customer typed before it goes into an email body. */
const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Title block under the logo band. `accent` tints the eyebrow for alerts. */
const emailTitle = (title: string, subtitle?: string | null, eyebrow?: string, accent?: string): string => `
  <tr><td style="padding: 32px 32px 0;">
    ${eyebrow ? `<p style="margin: 0 0 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: ${accent || RM_FAINT};">${esc(eyebrow)}</p>` : ''}
    <h1 style="margin: 0; font-size: 21px; font-weight: 700; color: ${RM_INK}; line-height: 1.3;">${esc(title)}</h1>
    ${subtitle ? `<p style="margin: 6px 0 0; font-size: 15px; color: ${RM_MUTED};">${esc(subtitle)}</p>` : ''}
  </td></tr>`;

/** A pill, e.g. the booking-confirmed badge. */
const emailPills = (pills: Array<[string, string]>): string => !pills.length ? '' : `
  <tr><td style="padding: 18px 32px 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
      ${pills.map(([label, bg], i) => `<td style="${i ? 'padding-left: 8px;' : ''}"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="background-color: ${bg}; color: #ffffff; padding: 7px 14px; border-radius: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">${esc(label)}</td></tr></table></td>`).join('')}
    </tr></table>
  </td></tr>`;

/**
 * Label/value rows in a bordered card. A row whose value is null, undefined or '' is dropped
 * rather than printed as "Not captured" — an absent line reads better than a filled-in absence.
 * Pass a third element to colour the value (money, for instance).
 */
const emailFacts = (rows: Array<[string, string | null | undefined, string?]>): string => {
  const live = rows.filter(([, v]) => v != null && String(v) !== '');
  if (!live.length) return '';
  return `
  <tr><td style="padding: 20px 32px 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${RM_WASH}; border: 1px solid ${RM_LINE}; border-radius: 10px;">
      <tr><td style="padding: 16px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          ${live.map(([label, value, accent]) => `
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: ${RM_MUTED}; white-space: nowrap; vertical-align: top;">${esc(label)}</td>
            <td style="padding: 6px 0 6px 16px; font-size: 14px; color: ${accent || RM_INK}; font-weight: ${accent ? '600' : '500'};">${value}</td>
          </tr>`).join('')}
        </table>
      </td></tr>
    </table>
  </td></tr>`;
};

/** A titled block of prose. `html` is trusted — callers escape their own interpolations. */
const emailSection = (heading: string | null, html: string): string => `
  <tr><td style="padding: 26px 32px 0;">
    ${heading ? `<h2 style="margin: 0 0 8px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: ${RM_FAINT};">${esc(heading)}</h2>` : ''}
    <div style="font-size: 15px; line-height: 1.65; color: ${RM_INK};">${html}</div>
  </td></tr>`;

/** The one thing that matters, in a tinted rail. */
const emailCallout = (html: string, accent: string): string => `
  <tr><td style="padding: 24px 32px 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${RM_WASH}; border-left: 4px solid ${accent}; border-radius: 6px;">
      <tr><td style="padding: 14px 18px; font-size: 15px; line-height: 1.6; color: ${RM_INK};">${html}</td></tr>
    </table>
  </td></tr>`;

/** Single primary action. Flat brand fill — gradients render unevenly in Outlook. */
const emailButton = (href: string, label: string, note?: string | null): string => `
  <tr><td style="padding: 28px 32px 32px; text-align: center;">
    <a href="${href}" style="display: inline-block; padding: 14px 30px; background-color: ${RM_BRAND}; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">${esc(label)}</a>
    ${note ? `<p style="margin: 14px 0 0; font-size: 13px; color: ${RM_MUTED};">${esc(note)}</p>` : ''}
  </td></tr>`;

/** Closing line of prose, e.g. where to ask for help. */
const emailFootnote = (html: string): string => `
  <tr><td style="padding: 0 32px 36px; font-size: 14px; line-height: 1.6; color: ${RM_MUTED}; text-align: center;">${html}</td></tr>`;

const generateCallSummaryHtml = (data: CallSummaryEmailData): string => {
  const {
    branchName,
    summary,
    transcript,
    durationSeconds,
    callType,
    customerName,
    customerPhone,
    registrationNumber,
    confirmedBooking,
    capturedRevenue,
    createdAt,
    bookingDate,
    priceQuoted,
  } = data;

  const date = new Date(createdAt);
  const formattedDate = date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const formattedTime = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const formattedBookingDate = bookingDate ? new Date(bookingDate).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) : null;

  return brandedEmailShell(`
    ${emailTitle('New call handled', branchName)}
    ${emailPills([
      ...(callType ? ([[callType, RM_BRAND]] as Array<[string, string]>) : []),
      ...(confirmedBooking ? ([['✓ Booking confirmed', RM_GOOD]] as Array<[string, string]>) : []),
    ])}
    ${emailFacts([
      ['Call date', `${formattedDate} at ${formattedTime}`],
      ['Duration', formatDuration(durationSeconds)],
      ['Customer', esc(customerName)],
      ['Phone', esc(customerPhone)],
      ['Registration', esc(registrationNumber)],
      ['Booking', formattedBookingDate],
      ['Price quoted', priceQuoted ? `£${priceQuoted.toFixed(2)}` : null],
      ['Value', capturedRevenue ? `£${capturedRevenue.toFixed(2)}` : null, RM_GOOD],
    ])}
    ${emailSection('Summary', esc(summary))}
    ${emailButton(
      'https://portal.receptionmate.co.uk/calls',
      'Listen to the recording',
      'The full recording and transcript are in your portal',
    )}
  `);
};

const generateCallSummaryText = (data: CallSummaryEmailData): string => {
  const {
    branchName,
    summary,
    transcript,
    durationSeconds,
    callType,
    customerName,
    customerPhone,
    registrationNumber,
    confirmedBooking,
    capturedRevenue,
    createdAt,
    bookingDate,
    priceQuoted,
  } = data;

  const date = new Date(createdAt);
  const formattedDate = date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const formattedTime = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const formattedBookingDate = bookingDate ? new Date(bookingDate).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) : null;

  let text = `ReceptionMate - New Call Handled\n`;
  text += `${'='.repeat(60)}\n\n`;
  text += `Branch: ${branchName}\n`;
  text += `Call Date: ${formattedDate} at ${formattedTime}\n`;
  text += `Duration: ${formatDuration(durationSeconds)}\n`;
  text += `Call Type: ${callType}\n`;
  
  if (confirmedBooking) {
    text += `Status: ✓ BOOKING CONFIRMED\n`;
  }
  
  if (customerName) {
    text += `Customer: ${customerName}\n`;
  }
  
  if (customerPhone) {
    text += `Phone: ${customerPhone}\n`;
  }
  
  if (registrationNumber) {
    text += `Registration: ${registrationNumber}\n`;
  }
  
  if (formattedBookingDate) {
    text += `Booking Date: ${formattedBookingDate}\n`;
  }
  
  if (priceQuoted) {
    text += `Price Quoted: £${priceQuoted.toFixed(2)}\n`;
  }
  
  if (capturedRevenue) {
    text += `Revenue Captured: £${capturedRevenue.toFixed(2)}\n`;
  }
  
  text += `\nCall Summary:\n`;
  text += `${'-'.repeat(60)}\n`;
  text += `${summary}\n\n`;
  
  text += `Full Transcript:\n`;
  text += `${'-'.repeat(60)}\n`;
  text += `${formatTranscript(transcript)}\n\n`;
  
  text += `${'='.repeat(60)}\n`;
  text += `This is an automated notification from ReceptionMate\n`;
  text += `Intelligent call handling for your business\n`;
  
  return text;
};

export const sendCallSummaryEmail = async (
  notificationEmails: string[],
  data: CallSummaryEmailData,
): Promise<boolean> => {
  if (notificationEmails.length === 0) {
    console.log('No notification emails configured, skipping email send');
    return false;
  }

  const html = generateCallSummaryHtml(data);
  const text = generateCallSummaryText(data);

  return sendEmail({
    to: notificationEmails,
    subject: 'ReceptionMate Handled A Call for you',
    html,
    text,
  });
};

/** What a chat conversation is reachable on, for the email's heading and Channel row. */
const CHAT_CHANNEL_LABELS: Record<string, string> = {
  widget: 'website chat',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram DM',
  facebook: 'Facebook Messenger',
};

export interface ChatSummaryEmailData {
  branchName: string;
  /** ChatConversation.platform */
  platform: string;
  summary: string;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  registrationNumber?: string | null;
  serviceName?: string | null;
  confirmedBooking?: boolean;
  capturedRevenue?: number | null;
  /** Prose, e.g. "Mon 19 Oct, drop off 8:30-9:30am" — chat bookings are often a window. */
  bookingDescription?: string | null;
  createdAt: string;
  conversationId: string;
  /** Tags the EmailLog row, so the summary shows on the garage's own email log. */
  garageId?: string | null;
}

/**
 * The chat equivalent of sendCallSummaryEmail: the agent booked something over the website
 * widget or WhatsApp and the garage should hear about it.
 *
 * Carries a SUMMARY and no transcript. A call email cannot show you the conversation, so it
 * links to the recording; a chat email could paste the whole thing, and shouldn't — forty lines
 * of back-and-forth is the fastest way to make a booking notification go unread. The full
 * conversation is one click away on the button.
 */
export const sendChatSummaryEmail = async (
  notificationEmails: string[],
  data: ChatSummaryEmailData,
): Promise<boolean> => {
  if (notificationEmails.length === 0) {
    console.log('[EMAIL] No notification emails configured, skipping chat summary');
    return false;
  }

  const {
    branchName, platform, summary, customerName, customerPhone, customerEmail,
    registrationNumber, serviceName, confirmedBooking, capturedRevenue,
    bookingDescription, createdAt, conversationId,
  } = data;

  const portalUrl = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';
  const channel = CHAT_CHANNEL_LABELS[platform] || 'chat';
  const d = new Date(createdAt);
  const when =
    `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} at ` +
    `${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  const link = `${portalUrl}/messages?conversation=${encodeURIComponent(conversationId)}`;
  const who = customerName || customerPhone || branchName;

  const html = brandedEmailShell(`
    ${emailTitle(
      confirmedBooking ? `New booking from your ${channel}` : `New ${channel} conversation`,
      branchName,
    )}
    ${emailPills(confirmedBooking ? ([['✓ Booking confirmed', RM_GOOD]] as Array<[string, string]>) : [])}
    ${emailFacts([
      ['Channel', channel.charAt(0).toUpperCase() + channel.slice(1)],
      ['Received', when],
      ['Customer', esc(customerName)],
      ['Phone', esc(customerPhone)],
      ['Email', esc(customerEmail)],
      ['Registration', esc(registrationNumber)],
      ['Service', esc(serviceName)],
      ['Booking', esc(bookingDescription)],
      ['Value', capturedRevenue ? `£${capturedRevenue.toFixed(2)}` : null, RM_GOOD],
    ])}
    ${emailSection('Summary', esc(summary))}
    ${emailButton(link, 'Open this conversation', 'The full conversation is in your ReceptionMate inbox')}
  `);

  let text = `${confirmedBooking ? 'NEW BOOKING' : 'NEW CONVERSATION'}\n${'='.repeat(56)}\n\n`;
  text += `Branch: ${branchName}\nChannel: ${channel}\nReceived: ${when}\n`;
  if (confirmedBooking) text += `Status: BOOKING CONFIRMED\n`;
  if (customerName) text += `Customer: ${customerName}\n`;
  if (customerPhone) text += `Phone: ${customerPhone}\n`;
  if (customerEmail) text += `Email: ${customerEmail}\n`;
  if (registrationNumber) text += `Registration: ${registrationNumber}\n`;
  if (serviceName) text += `Service: ${serviceName}\n`;
  if (bookingDescription) text += `Booking: ${bookingDescription}\n`;
  if (capturedRevenue) text += `Value: £${capturedRevenue.toFixed(2)}\n`;
  text += `\nSummary:\n${'-'.repeat(56)}\n${summary}\n\nOpen this conversation: ${link}\n`;

  return sendEmail({
    to: notificationEmails,
    subject: confirmedBooking
      ? `New ${channel} booking — ${who}`
      : `New ${channel} conversation — ${who}`,
    html,
    text,
    template: confirmedBooking ? 'chat_booking_summary' : 'chat_conversation_summary',
    garageId: data.garageId ?? null,
  });
};

interface PaymentSetupReminderEmailData {
  branchName: string;
  summary: string;
  customerPhone?: string | null;
  createdAt: string;
  portalUrl: string;
}

export const sendPaymentSetupReminderEmail = async (
  notificationEmails: string[],
  data: PaymentSetupReminderEmailData,
): Promise<boolean> => {
  if (notificationEmails.length === 0) {
    console.log('No notification emails configured for payment setup reminder');
    return false;
  }

  const date = new Date(data.createdAt);
  const formattedDate = date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const html = brandedEmailShell(`
    ${emailTitle('Set up your Direct Debit', data.branchName, 'Action required', RM_WARN)}
    ${emailSection(
      null,
      `<p style="margin: 0 0 14px;"><strong>Good news</strong> &mdash; ReceptionMate handled a call for you on ${formattedDate}.</p>` +
      `<p style="margin: 0;">Your Direct Debit mandate is not active yet. Completing it keeps your service running and restores your full call details.</p>`,
    )}
    ${emailFacts([['Call received', formattedDate]])}
    ${emailCallout(
      'To keep receiving full call details and uninterrupted service, please set up your Direct Debit mandate as soon as you can.',
      RM_WARN,
    )}
    ${emailButton(`${data.portalUrl}/login`, 'Complete Direct Debit setup')}
    ${emailFootnote(`Questions? Email <a href="mailto:hello@receptionmate.co.uk" style="color: ${RM_BRAND}; text-decoration: none;">hello@receptionmate.co.uk</a>`)}
  `);

  const text = `
⚠️ ACTION REQUIRED: DIRECT DEBIT SETUP

${data.branchName}

Good news! ReceptionMate handled a call for you on ${formattedDate}.

However, we noticed that your Direct Debit mandate is not currently active. To ensure uninterrupted service and receive full call details, please complete your payment setup.

CALL DETAILS:
📞 Call Received: ${formattedDate}

⚠️ IMPORTANT:
To continue receiving full call details and maintain uninterrupted service, please set up your Direct Debit mandate as soon as possible.

Complete your setup here: ${data.portalUrl}/login

Questions? Contact us at hello@receptionmate.co.uk

---
This is an automated email from ReceptionMate
`;

  return sendEmail({
    to: notificationEmails,
    subject: 'ReceptionMate handled a call for you',
    html,
    text,
  });
};

interface ArrearsCallNoticeEmailData {
  branchName: string;
  createdAt: string;
  portalUrl: string;
}

// ReceptionMate brand assets for transactional emails (match the portal / marketing site).
const RM_LOGO_URL = 'https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png';
const RM_BRAND = '#3426cf';       // brand-600 (primary indigo)
const RM_BRAND_DARK = '#281eb0';  // brand-700

/**
 * Shared branded shell for arrears emails: white card on light grey, an indigo header
 * band carrying the ReceptionMate logo, and a consistent footer. Callers pass the inner
 * body HTML. Keeps every arrears email on-brand with the portal.
 */
const arrearsEmailShell = (bodyHtml: string): string => brandedEmailShell(bodyHtml);

/**
 * Arrears notice — sent instead of the full call summary when a garage is flagged
 * accessRestricted. Deliberately contains NO call content (no caller, summary, transcript
 * or recording): it only confirms a call was handled, explains that the Direct Debit has failed,
 * and points at setting it back up. The portal link is /login deliberately — with
 * mustSetupPayment set, signing in lands them straight on /setup-payment.
 */
export const sendArrearsCallNoticeEmail = async (
  notificationEmails: string[],
  data: ArrearsCallNoticeEmailData,
): Promise<boolean> => {
  if (notificationEmails.length === 0) {
    console.log('No notification emails configured for arrears call notice');
    return false;
  }

  const date = new Date(data.createdAt);
  const formattedDate = date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const html = arrearsEmailShell(`
          <tr>
            <td style="padding: 36px 32px 8px; text-align: center;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 600; color: #1d1a72;">📞 We handled a call for you</h1>
              <p style="margin: 8px 0 0; font-size: 15px; color: #6b7194;">${data.branchName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px 0;">
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #3a3f5c;">
                Good news first — your ReceptionMate receptionist answered a call for you on
                <strong>${formattedDate}</strong>, and we're still picking up every call as normal.
              </p>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #3a3f5c;">
                The reason we're emailing rather than sending the usual summary is that your
                <strong>Direct Debit has failed</strong> and the account has fallen into arrears. Until that's
                sorted, the caller's details, the summary, transcript and recording are on hold.
              </p>
              <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.6; color: #3a3f5c;">
                Setting your Direct Debit back up takes a couple of minutes, and everything unlocks in your
                portal straight away — including this call and any others we've handled in the meantime.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding: 16px 20px; background-color: #fff8ec; border: 1px solid #f6dfae; border-radius: 10px; font-size: 14px; line-height: 1.5; color: #8a6417;">
                    <strong>📞 Call handled:</strong> ${formattedDate}<br/>
                    <strong>🔓 Details:</strong> unlocked as soon as your Direct Debit is set up
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 32px 4px; text-align: center;">
              <a href="${data.portalUrl}/login" style="display: inline-block; padding: 14px 30px; background-color: ${RM_BRAND}; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 10px;">
                Set up my Direct Debit
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px 32px; text-align: center;">
              <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #8b90b0;">
                If you think this is a mistake, or you'd rather sort it over the phone, just reply to this
                email or contact us at <a href="mailto:hello@receptionmate.co.uk" style="color: ${RM_BRAND}; text-decoration: none;">hello@receptionmate.co.uk</a> — we're happy to help.
              </p>
            </td>
          </tr>`);

  const text = `
WE HANDLED A CALL FOR YOU

${data.branchName}

Good news first - your ReceptionMate receptionist answered a call for you on ${formattedDate}, and we're still picking up every call as normal.

The reason we're emailing rather than sending the usual summary is that your DIRECT DEBIT HAS FAILED and the account has fallen into arrears. Until that's sorted, the caller's details, the summary, transcript and recording are on hold.

Setting your Direct Debit back up takes a couple of minutes, and everything unlocks in your portal straight away - including this call and any others we've handled in the meantime.

Call handled: ${formattedDate}
Details: unlocked as soon as your Direct Debit is set up

Set up your Direct Debit: ${data.portalUrl}/login

If you think this is a mistake, or you'd rather sort it over the phone, just reply to this email or contact us at hello@receptionmate.co.uk - we're happy to help.

---
This is an automated email from ReceptionMate
`;

  return sendEmail({
    to: notificationEmails,
    // This one ends "just reply to this email"; without Reply-To that lands nowhere.
    replyTo: SUPPORT_REPLY_TO,
    subject: 'We handled a call for you — your Direct Debit needs setting up',
    html,
    text,
  });
};

interface ArrearsWarningEmailData {
  branchName: string;
  portalUrl: string;
  graceDays: number;
}

/**
 * Payment-failed warning — sent to the garage (billing + notification emails) as soon
 * as a Stripe card charge fails. Advises the payment failed, that we'll retry, and that
 * access will be limited if it isn't brought up to date within the grace window.
 */
export interface LatePaymentEmailData {
  customerName: string;
  finalNotice?: boolean;   // second chase, 14 days after the first
  // Which reminder this is, in words ("second", "third"). The final-notice copy used to
  // hard-code "second"; a reminder sent by hand after two automated ones then told the
  // customer something they could see was untrue.
  reminderOrdinal?: string;
  amount: string;          // formatted, e.g. "£1,855.50"
  dueDate: string;         // e.g. "15 August 2026"
  daysOverdue: number;
  lines?: Array<{ label: string; amount: string }>;  // e.g. per-branch breakdown
  // Invoices that are issued but NOT yet past their terms, listed so a customer who is late on
  // one month can settle both in a single transfer. Kept apart from `lines` on purpose: folding
  // them into the headline would describe money as overdue that is not, which is both wrong and
  // the kind of error a customer remembers. When present, `amount` stays the OVERDUE figure and
  // `totalOutstanding` carries the combined one.
  upcoming?: Array<{ label: string; amount: string; due: string }>;
  totalOutstanding?: string;
  ddSetupUrl?: string;     // omitted → the Direct Debit section is left out
  portalUrl?: string;
  // The invoices being chased, as PDFs. A reminder that asks somebody to pay but makes them go
  // and find the invoice first is a reminder that gets postponed — and for a multi-branch
  // customer the original was one combined email a fortnight earlier, long since buried.
  attachments?: EmailAttachment[];
}

/**
 * Late payment reminder for customers who pay on invoice rather than Direct Debit.
 *
 * Deliberately gentle: it opens by excusing anyone who paid in the last day or two, since with
 * 14-day terms and manual reconciliation we WILL sometimes chase someone who has already paid.
 * It makes no threat — the contract allows suspension at 30 days, and that belongs in a second,
 * firmer message rather than a first reminder. Direct Debit is offered as convenience, not
 * compliance, because the point is to stop this recurring rather than to scold.
 */
export interface PaymentFailedEmailData {
  branchName: string;
  retryDays: number;
  cc?: string[];        // keep ourselves copied in, so a reply lands somewhere we watch
  ddSetupUrl?: string;  // only when the mandate itself is dead and needs re-authorising
  mandateDead?: boolean;
}

/**
 * Direct Debit collection failed — tell the customer, and tell them we're handling it.
 *
 * The existing arrears warning is Stripe wording ("the card was declined") and only ever fired
 * for card customers. Direct Debit customers got nothing at all: Caldwell & Dempster bounced on
 * 30 June, kept taking 40 calls a month, and were never told. Most BACS failures are just funds
 * on the day, so the tone is "no action needed, we'll retry" unless the mandate is actually gone.
 *
 * Deliberately no amount, anywhere. A failed collection can carry several months at once —
 * EAC Telford's was £709.92 against a £325 subscription — and leading with a figure like that
 * turns a two-minute admin fix into an argument about the bill. The amount is in the portal and
 * on the invoice for anyone who wants it; the email's job is to get the mandate reinstated.
 */
export const sendPaymentFailedEmail = async (
  recipients: string[],
  data: PaymentFailedEmailData,
): Promise<boolean> => {
  if (recipients.length === 0) return false;

  const body = data.mandateDead
    ? `
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding: 16px 20px; background-color: #f7f7fb; border: 1px solid #e9eaf5; border-radius: 10px; font-size: 15px; line-height: 1.6; color: #3a3f5c;">
                    <strong>Don't worry — your receptionist is still answering your calls.</strong>
                    Some features and call details may be unavailable in your portal until the
                    Direct Debit is reactivated. Setting it up again takes about a minute.
                  </td>
                </tr>
              </table>`
    : `
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding: 16px 20px; background-color: #f7f7fb; border: 1px solid #e9eaf5; border-radius: 10px; font-size: 15px; line-height: 1.6; color: #3a3f5c;">
                    <strong>There's nothing you need to do.</strong> We'll automatically try again in
                    about ${data.retryDays} days, which usually sorts it. Your service carries on as
                    normal in the meantime — your AI receptionist keeps answering your calls.
                  </td>
                </tr>
              </table>`;

  const button = data.ddSetupUrl ? `
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 22px 0 0;">
                <tr>
                  <td style="border-radius: 10px; background-color: ${RM_BRAND};">
                    <a href="${data.ddSetupUrl}" style="display: inline-block; padding: 14px 26px; font-size: 16px;
                       font-weight: 600; color: #ffffff; text-decoration: none;">Set up Direct Debit</a>
                  </td>
                </tr>
              </table>` : '';

  const html = arrearsEmailShell(`
          <tr>
            <td style="padding: 36px 32px 8px; text-align: center;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 600; color: #1d1a72;">Your Direct Debit didn't go through</h1>
              <p style="margin: 8px 0 0; font-size: 15px; color: #6b7194;">${data.branchName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px 32px;">
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #3a3f5c;">
                We weren't able to collect your latest ReceptionMate payment by Direct Debit.
              </p>
              ${body}
              ${button}
              <p style="margin: 22px 0 0; font-size: 16px; line-height: 1.6; color: #3a3f5c;">
                If something's changed with your bank details, or you'd like to sort it over the
                phone, just reply to this email and we'll take care of it.
              </p>
            </td>
          </tr>`);

  const text = [
    `Your Direct Debit didn't go through — ${data.branchName}`, '',
    "We weren't able to collect your latest ReceptionMate payment by Direct Debit.", '',
    data.mandateDead
      ? `Don't worry - your receptionist is still answering your calls. Some features and call details may be unavailable in your portal until the Direct Debit is reactivated. Setting it up again takes about a minute.${data.ddSetupUrl ? `\n\nSet up Direct Debit: ${data.ddSetupUrl}` : ''}`
      : `There's nothing you need to do — we'll automatically try again in about ${data.retryDays} days. Your service carries on as normal.`,
    '', "If something has changed with your bank details, or you'd like to sort it over the phone, just reply and we'll take care of it.",
  ].join('\n');

  return sendEmail({
    to: recipients,
    ...(data.cc?.length ? { cc: data.cc } : {}),
    // Ends "just reply to this email and we'll take care of it" — so it must be repliable.
    replyTo: SUPPORT_REPLY_TO,
    // A cancelled mandate is not a blip: nothing will be collected until someone re-authorises
    // it, and a subject that reads like a temporary hiccup gets treated like one. EAC Telford ran
    // 16 days on the old wording.
    subject: data.mandateDead
      ? 'Action needed — your Direct Debit is no longer active'
      : "Your Direct Debit didn't go through",
    html,
    text,
  });
};
export const sendLatePaymentEmail = async (
  recipients: string[],
  data: LatePaymentEmailData,
  cc?: string[],
): Promise<boolean> => {
  if (recipients.length === 0) {
    console.log('No recipients configured for late payment email');
    return false;
  }

  const ordinalWord = data.reminderOrdinal || 'second';

  const lineRows = (data.lines || []).map((l) => `
                  <tr>
                    <td style="padding: 4px 0; font-size: 15px; color: #3a3f5c;">${l.label}</td>
                    <td style="padding: 4px 0; font-size: 15px; color: #1d1a72; font-weight: 600; text-align: right;">${l.amount}</td>
                  </tr>`).join('');

  const heading = (text: string, first: boolean) => `
                  <tr>
                    <td colspan="2" style="padding: ${first ? '0' : '14px'} 0 6px; font-size: 11px; font-weight: 700;
                        letter-spacing: 0.06em; color: #8b90b0;">${text}</td>
                  </tr>`;

  const upcomingRows = (data.upcoming || []).map((l) => `
                  <tr>
                    <td style="padding: 4px 0; font-size: 15px; color: #3a3f5c;">${l.label}<br>
                      <span style="font-size: 13px; color: #8b90b0;">due ${l.due}</span></td>
                    <td style="padding: 4px 0; font-size: 15px; color: #1d1a72; font-weight: 600; text-align: right; vertical-align: top;">${l.amount}</td>
                  </tr>`).join('');

  // With an upcoming section the table needs labelled groups and two totals, so the overdue
  // figure stays the one being chased and the combined figure is clearly just the balance.
  const grouped = upcomingRows ? `
                ${heading('OVERDUE', true)}
                ${lineRows}
                <tr>
                  <td style="padding: 8px 0 0; border-top: 1px solid #e9eaf5; font-size: 15px; font-weight: 700; color: #1d1a72;">Overdue now</td>
                  <td style="padding: 8px 0 0; border-top: 1px solid #e9eaf5; font-size: 15px; font-weight: 700; color: #1d1a72; text-align: right;">${data.amount}</td>
                </tr>
                ${heading('NOT YET DUE', false)}
                ${upcomingRows}
                ${data.totalOutstanding ? `
                <tr>
                  <td style="padding: 12px 0 0; border-top: 2px solid #e9eaf5; font-size: 15px; font-weight: 700; color: #1d1a72;">Total outstanding</td>
                  <td style="padding: 12px 0 0; border-top: 2px solid #e9eaf5; font-size: 15px; font-weight: 700; color: #1d1a72; text-align: right;">${data.totalOutstanding}</td>
                </tr>` : ''}` : `
                ${lineRows}
                <tr>
                  <td style="padding: 10px 0 0; border-top: 1px solid #e9eaf5; font-size: 15px; font-weight: 700; color: #1d1a72;">Total</td>
                  <td style="padding: 10px 0 0; border-top: 1px solid #e9eaf5; font-size: 15px; font-weight: 700; color: #1d1a72; text-align: right;">${data.amount}</td>
                </tr>`;

  const breakdown = (lineRows || upcomingRows) ? `
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"
                     style="margin: 0 0 20px; padding: 16px 20px; background-color: #f7f7fb; border: 1px solid #e9eaf5; border-radius: 10px;">
                ${grouped}
              </table>` : '';

  // Said immediately after the table, where someone looking at two numbers decides what to pay.
  const upcomingNote = upcomingRows ? `
              <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #6b7194;">
                Nothing is needed yet on the ${data.upcoming!.length === 1 ? 'invoice' : 'invoices'} shown as not yet due —
                ${data.upcoming!.length === 1 ? "it's" : "they're"} listed only so you can settle everything in one transfer
                if that's easier for you.
              </p>` : '';

  const ddBlock = data.ddSetupUrl ? `
              <p style="margin: 24px 0 8px; font-size: 16px; font-weight: 600; color: #1d1a72;">Would Direct Debit be easier?</p>
              <p style="margin: 0 0 18px; font-size: 16px; line-height: 1.6; color: #3a3f5c;">
                Most of our customers pay this way — it collects automatically on the same date each
                month, so there's nothing to remember and no risk of a missed invoice interrupting
                your service. It takes about a minute to set up and you can cancel it at any time.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 22px;">
                <tr>
                  <td style="border-radius: 10px; background-color: ${RM_BRAND};">
                    <a href="${data.ddSetupUrl}" style="display: inline-block; padding: 14px 26px; font-size: 16px;
                       font-weight: 600; color: #ffffff; text-decoration: none;">Set up Direct Debit</a>
                  </td>
                </tr>
              </table>` : '';

  const html = arrearsEmailShell(`
          <tr>
            <td style="padding: 36px 32px 8px; text-align: center;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 600; color: #1d1a72;">${data.finalNotice ? 'Your invoice is still unpaid' : 'Your invoice is now overdue'}</h1>
              <p style="margin: 8px 0 0; font-size: 15px; color: #6b7194;">${data.customerName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px 32px;">
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #3a3f5c;">
                Our records show your invoice for <strong>${data.amount}</strong> was due on
                ${data.dueDate} and is still showing as unpaid — ${data.daysOverdue} day${data.daysOverdue === 1 ? '' : 's'}
                past our 14&nbsp;day terms. If you've already sent it across in the last day or two,
                thank you, and please ignore this.
              </p>
              ${data.finalNotice ? `
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 18px;">
                <tr>
                  <td style="padding: 16px 20px; background-color: #fef3f2; border: 1px solid #fbd5d0; border-radius: 10px; font-size: 15px; line-height: 1.6; color: #7a2b23;">
                    This is our ${ordinalWord} reminder. Under our agreement, accounts unpaid after 30 days may
                    have their service restricted on 5 days' notice — we'd much rather not do that, so
                    please let us know if there's a problem and we'll work something out.
                  </td>
                </tr>
              </table>` : ''}
              ${breakdown}
              ${upcomingNote}
              ${ddBlock}
              <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #6b7194;">
                Prefer to pay this one by transfer? Our bank details are on the invoice${data.portalUrl ? `,
                and you can view it any time in <a href="${data.portalUrl}" style="color: ${RM_BRAND};">the portal</a>` : ''}.
              </p>
              <p style="margin: 0; font-size: 16px; line-height: 1.6; color: #3a3f5c;">
                If there's a problem with the invoice, or the timing doesn't work this month, just
                reply to this email and we'll sort it out.
              </p>
            </td>
          </tr>`);

  const text = [
    `${data.finalNotice ? 'Your invoice is still unpaid' : 'Your invoice is now overdue'} — ${data.customerName}`,
    '',
    `Our records show your invoice for ${data.amount} was due on ${data.dueDate} and is still showing`,
    `as unpaid — ${data.daysOverdue} day${data.daysOverdue === 1 ? '' : 's'} past our 14 day terms. If you've already sent it across in the`,
    'last day or two, thank you, and please ignore this.',
    '',
    ...(data.lines?.length ? [
      ...(data.upcoming?.length ? ['OVERDUE'] : []),
      ...data.lines.map((l) => `  ${l.label}: ${l.amount}`),
      `  ${data.upcoming?.length ? 'Overdue now' : 'Total'}: ${data.amount}`,
      '',
    ] : []),
    ...(data.upcoming?.length ? [
      'NOT YET DUE',
      ...data.upcoming.map((l) => `  ${l.label}: ${l.amount} (due ${l.due})`),
      ...(data.totalOutstanding ? [`  Total outstanding: ${data.totalOutstanding}`] : []),
      '',
      `Nothing is needed yet on the ${data.upcoming.length === 1 ? 'invoice' : 'invoices'} shown as not yet due —`,
      `${data.upcoming.length === 1 ? 'it is' : 'they are'} listed only so you can settle everything in one transfer if that is easier.`,
      '',
    ] : []),
    ...(data.ddSetupUrl ? [
      'Would Direct Debit be easier? Most of our customers pay this way — it collects automatically',
      'on the same date each month, so there is nothing to remember and no risk of a missed invoice',
      'interrupting your service. It takes about a minute to set up and you can cancel at any time.',
      '', data.ddSetupUrl, '',
    ] : []),
    'If there is a problem with the invoice, or the timing does not work this month, just reply and',
    'we will sort it out.',
  ].join('\n');

  return sendEmail({ to: recipients, cc,
    // Ends "reply to this email and we'll sort it out" — a disputed invoice is
    // exactly the reply we most want to receive.
    replyTo: SUPPORT_REPLY_TO,
    subject: data.finalNotice
      ? `${ordinalWord.charAt(0).toUpperCase() + ordinalWord.slice(1)} reminder: invoice still unpaid — ${data.amount}`
      : `Invoice overdue — ${data.amount}`,
    html, text,
    ...(data.attachments?.length ? { attachments: data.attachments } : {}),
    template: data.finalNotice ? 'invoice_chase_2' : 'invoice_chase_1' });
};

export const sendArrearsWarningEmail = async (
  recipients: string[],
  data: ArrearsWarningEmailData,
): Promise<boolean> => {
  if (recipients.length === 0) {
    console.log('No recipients configured for arrears warning email');
    return false;
  }

  const html = arrearsEmailShell(`
          <tr>
            <td style="padding: 36px 32px 8px; text-align: center;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 600; color: #1d1a72;">⚠️ We couldn't take your payment</h1>
              <p style="margin: 8px 0 0; font-size: 15px; color: #6b7194;">${data.branchName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px 0;">
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #3a3f5c;">
                We tried to take your ReceptionMate subscription payment but the card was declined.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding: 16px 20px; background-color: #fef3f2; border: 1px solid #fbd5d0; border-radius: 10px; font-size: 15px; line-height: 1.6; color: #7a2b23;">
                    We'll automatically retry over the next few days. To avoid any interruption, please update your
                    payment details. If your account isn't brought up to date within <strong>${data.graceDays} days</strong>,
                    portal access will be limited until payment is received — though your AI receptionist will keep
                    answering your calls throughout.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 32px 4px; text-align: center;">
              <a href="${data.portalUrl}/login" style="display: inline-block; padding: 14px 30px; background-color: ${RM_BRAND}; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 10px;">
                Update my payment details
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px 32px; text-align: center;">
              <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #8b90b0;">
                Questions? Contact us at <a href="mailto:hello@receptionmate.co.uk" style="color: ${RM_BRAND}; text-decoration: none;">hello@receptionmate.co.uk</a>
              </p>
            </td>
          </tr>`);

  const text = `
WE COULDN'T TAKE YOUR PAYMENT

${data.branchName}

We tried to take your ReceptionMate subscription payment but the card was declined.

We'll automatically retry over the next few days. To avoid any interruption, please update your payment details. If your account isn't brought up to date within ${data.graceDays} days, portal access will be limited until payment is received — though your AI receptionist will keep answering your calls throughout.

Update your payment details: ${data.portalUrl}/login

Questions? Contact us at hello@receptionmate.co.uk

---
This is an automated email from ReceptionMate
`;

  return sendEmail({
    to: recipients,
    subject: 'Payment failed — please update your details',
    html,
    text,
  });
};

export interface ArrearsRestrictionNoticeEmailData {
  customerName: string;
  /** How the restriction date reads in the email, e.g. "Monday 13 October". */
  restrictionDate: string;
  /** Days between this email and the restriction date — stated so the notice period is explicit. */
  noticeDays: number;
  /** Optional sentence tying the date to the agreement, e.g. the 30-day clause it satisfies. */
  termsNote?: string;
  amount: string;
  dueDate: string;
  daysOverdue: number;
  lines?: Array<{ label: string; amount: string }>;
  upcoming?: Array<{ label: string; amount: string; due: string }>;
  totalOutstanding?: string;
  /** Pretty dates of the reminders already sent, so the notice can say what has gone before. */
  remindersSent?: string[];
  portalUrl?: string;
  attachments?: EmailAttachment[];
}

/**
 * Notice that an account is about to be restricted for non-payment.
 *
 * The step between sendLatePaymentEmail (a chase) and sendArrearsCallNoticeEmail (sent once the
 * restriction is live). Its whole job is to be unambiguous about two things people otherwise
 * assume the worst about: the calls keep being answered, and nothing is deleted. A customer who
 * reads "restricted" as "the phones stop" will either panic or dismiss it as a bluff, and both
 * of those cost us the payment this email exists to collect.
 *
 * Written for invoice-paying customers, so it talks about a transfer against the invoice rather
 * than offering to fix a card or a mandate.
 */
export const sendArrearsRestrictionNoticeEmail = async (
  recipients: string[],
  data: ArrearsRestrictionNoticeEmailData,
  cc?: string[],
): Promise<boolean> => {
  if (recipients.length === 0) {
    console.log('No recipients configured for arrears restriction notice');
    return false;
  }

  const lineRows = (data.lines || []).map((l) => `
                  <tr>
                    <td style="padding: 4px 0; font-size: 15px; color: #3a3f5c;">${l.label}</td>
                    <td style="padding: 4px 0; font-size: 15px; color: #1d1a72; font-weight: 600; text-align: right;">${l.amount}</td>
                  </tr>`).join('');

  const upcomingRows = (data.upcoming || []).map((l) => `
                  <tr>
                    <td style="padding: 4px 0; font-size: 15px; color: #3a3f5c;">${l.label}<br>
                      <span style="font-size: 13px; color: #8b90b0;">due ${l.due}</span></td>
                    <td style="padding: 4px 0; font-size: 15px; color: #1d1a72; font-weight: 600; text-align: right; vertical-align: top;">${l.amount}</td>
                  </tr>`).join('');

  const groupHeading = (text: string, first: boolean) => `
                  <tr>
                    <td colspan="2" style="padding: ${first ? '0' : '14px'} 0 6px; font-size: 11px; font-weight: 700;
                        letter-spacing: 0.06em; color: #8b90b0;">${text}</td>
                  </tr>`;

  // Only the overdue figure is what the restriction turns on, so the not-yet-due invoice is
  // listed under its own heading with its own total and never folded into the headline amount.
  const breakdown = (lineRows || upcomingRows) ? `
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"
                     style="margin: 0 0 20px; padding: 16px 20px; background-color: #f7f7fb; border: 1px solid #e9eaf5; border-radius: 10px;">
                ${upcomingRows ? `
                ${groupHeading('OVERDUE — PAYABLE NOW', true)}
                ${lineRows}
                <tr>
                  <td style="padding: 8px 0 0; border-top: 1px solid #e9eaf5; font-size: 15px; font-weight: 700; color: #1d1a72;">Overdue now</td>
                  <td style="padding: 8px 0 0; border-top: 1px solid #e9eaf5; font-size: 15px; font-weight: 700; color: #1d1a72; text-align: right;">${data.amount}</td>
                </tr>
                ${groupHeading('NOT YET DUE', false)}
                ${upcomingRows}
                ${data.totalOutstanding ? `
                <tr>
                  <td style="padding: 12px 0 0; border-top: 2px solid #e9eaf5; font-size: 15px; font-weight: 700; color: #1d1a72;">Total outstanding</td>
                  <td style="padding: 12px 0 0; border-top: 2px solid #e9eaf5; font-size: 15px; font-weight: 700; color: #1d1a72; text-align: right;">${data.totalOutstanding}</td>
                </tr>` : ''}` : `
                ${lineRows}
                <tr>
                  <td style="padding: 10px 0 0; border-top: 1px solid #e9eaf5; font-size: 15px; font-weight: 700; color: #1d1a72;">Total overdue</td>
                  <td style="padding: 10px 0 0; border-top: 1px solid #e9eaf5; font-size: 15px; font-weight: 700; color: #1d1a72; text-align: right;">${data.amount}</td>
                </tr>`}
              </table>` : '';

  const reminderSentence = data.remindersSent?.length
    ? ` We wrote to you about it on ${data.remindersSent.join(' and ')}.`
    : '';

  const html = arrearsEmailShell(`
          <tr>
            <td style="padding: 36px 32px 8px; text-align: center;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 600; color: #1d1a72;">Your account will be restricted on ${data.restrictionDate}</h1>
              <p style="margin: 8px 0 0; font-size: 15px; color: #6b7194;">${data.customerName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px 32px;">
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #3a3f5c;">
                Your invoice for <strong>${data.amount}</strong> was due on ${data.dueDate} and is still
                showing as unpaid — ${data.daysOverdue} day${data.daysOverdue === 1 ? '' : 's'} past our
                14&nbsp;day terms.${reminderSentence}
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 22px;">
                <tr>
                  <td style="padding: 16px 20px; background-color: #fef3f2; border: 1px solid #fbd5d0; border-radius: 10px; font-size: 15px; line-height: 1.6; color: #7a2b23;">
                    Unless the overdue balance reaches us first, our system will automatically restrict
                    the account on <strong>${data.restrictionDate}</strong> — ${data.noticeDays} day${data.noticeDays === 1 ? '' : 's'}
                    from today. This email is that notice.${data.termsNote ? ` ${data.termsNote}` : ''}
                  </td>
                </tr>
              </table>
              <p style="margin: 0 0 12px; font-size: 16px; font-weight: 600; color: #1d1a72;">What a restriction does, and doesn't, mean</p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 14px;">
                <tr>
                  <td style="padding: 16px 20px; background-color: #f0fdf4; border: 1px solid #bbf0cd; border-radius: 10px; font-size: 15px; line-height: 1.6; color: #1f5f3a;">
                    <strong>Your calls keep being answered.</strong> Every call to your branches will be picked up
                    by your receptionist exactly as it is today, and bookings will keep going into your diary.
                    Nothing changes for the customer on the phone.
                  </td>
                </tr>
              </table>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 20px;">
                <tr>
                  <td style="padding: 16px 20px; background-color: #fff8ec; border: 1px solid #f6dfae; border-radius: 10px; font-size: 15px; line-height: 1.6; color: #8a6417;">
                    <strong>Call details go on hold.</strong> From ${data.restrictionDate}, the caller's name and
                    number, the summary, the transcript and the recording will not be available to you — not in the
                    portal and not in your call emails. Nothing is deleted: every call we handle in the meantime is
                    kept, and all of it unlocks the moment your payment reaches us.
                  </td>
                </tr>
              </table>
              ${breakdown}
              <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #6b7194;">
                ${data.upcoming?.length ? 'Only the overdue amount needs settling to stop the restriction — the invoice shown as not yet due is listed so you can send everything in one transfer if that is easier. ' : ''}Our
                bank details are on the invoice${data.attachments?.length ? ', attached again here' : ''}${data.portalUrl ? `, and you can view it any time in <a href="${data.portalUrl}" style="color: ${RM_BRAND};">the portal</a>` : ''}.
                If the payment has gone out in the last day or two, thank you — just reply so we can match it up and
                cancel the restriction.
              </p>
              <p style="margin: 0; font-size: 16px; line-height: 1.6; color: #3a3f5c;">
                We would much rather not restrict anything. If there is a hold-up at your end, reply to this email
                and tell us when we can expect payment, and we will hold off.
              </p>
            </td>
          </tr>`);

  const text = [
    `YOUR ACCOUNT WILL BE RESTRICTED ON ${data.restrictionDate.toUpperCase()}`,
    '',
    data.customerName,
    '',
    `Your invoice for ${data.amount} was due on ${data.dueDate} and is still showing as unpaid —`,
    `${data.daysOverdue} day${data.daysOverdue === 1 ? '' : 's'} past our 14 day terms.${reminderSentence}`,
    '',
    'Unless the overdue balance reaches us first, our system will automatically restrict the account',
    `on ${data.restrictionDate}`,
    `— ${data.noticeDays} day${data.noticeDays === 1 ? '' : 's'} from today. This email is that notice.`,
    ...(data.termsNote ? ['', data.termsNote] : []),
    '',
    'WHAT A RESTRICTION DOES, AND DOESN\'T, MEAN',
    '',
    'Your calls keep being answered. Every call to your branches will be picked up by your',
    'receptionist exactly as it is today, and bookings will keep going into your diary. Nothing',
    'changes for the customer on the phone.',
    '',
    `Call details go on hold. From ${data.restrictionDate}, the caller's name and number, the`,
    'summary, the transcript and the recording will not be available to you — not in the portal',
    'and not in your call emails. Nothing is deleted: every call we handle in the meantime is kept,',
    'and all of it unlocks the moment your payment reaches us.',
    '',
    ...(data.lines?.length ? [
      ...(data.upcoming?.length ? ['OVERDUE — PAYABLE NOW'] : []),
      ...data.lines.map((l) => `  ${l.label}: ${l.amount}`),
      `  ${data.upcoming?.length ? 'Overdue now' : 'Total overdue'}: ${data.amount}`,
      '',
    ] : []),
    ...(data.upcoming?.length ? [
      'NOT YET DUE',
      ...data.upcoming.map((l) => `  ${l.label}: ${l.amount} (due ${l.due})`),
      ...(data.totalOutstanding ? [`  Total outstanding: ${data.totalOutstanding}`] : []),
      '',
      'Only the overdue amount needs settling to stop the restriction — the invoice shown as not yet',
      'due is listed so you can send everything in one transfer if that is easier.',
      '',
    ] : []),
    `Our bank details are on the invoice${data.attachments?.length ? ', attached again here' : ''}${data.portalUrl ? `, and you can view it any time in the portal: ${data.portalUrl}` : ''}.`,
    'If the payment has gone out in the last day or two, thank you — just reply so we can match it',
    'up and cancel the restriction.',
    '',
    'We would much rather not restrict anything. If there is a hold-up at your end, reply to this',
    'email and tell us when we can expect payment, and we will hold off.',
  ].join('\n');

  return sendEmail({
    to: recipients,
    cc,
    // The reply we want most is "it is going out on Friday", so it has to land somewhere staffed.
    replyTo: SUPPORT_REPLY_TO,
    subject: `Action needed: account restricted on ${data.restrictionDate} — ${data.amount} overdue`,
    html,
    text,
    ...(data.attachments?.length ? { attachments: data.attachments } : {}),
    template: 'arrears_restriction_notice',
  });
};

interface NegativeFeedbackEmailData {
  branchName: string;
  callId: string;
  rating: 'down';
  reasons: string[];
  notes: string | null;
  userEmail: string;
  submittedAt: string;
}

export const sendNegativeFeedbackEmail = async (
  data: NegativeFeedbackEmailData,
): Promise<boolean> => {
  const { branchName, callId, reasons, notes, userEmail, submittedAt } = data;

  const date = new Date(submittedAt);
  const formattedDate = date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const html = brandedEmailShell(`
    ${emailTitle('Negative feedback received', branchName, 'Feedback', RM_BAD)}
    ${emailFacts([
      ['Submitted', formattedDate],
      ['User', esc(userEmail)],
      ['Call ID', esc(callId)],
    ])}
    ${emailSection(
      'Reasons given',
      reasons.length
        ? `<ul style="margin: 0; padding-left: 20px;">${reasons.map((r) => `<li style="margin: 0 0 4px;">${esc(r)}</li>`).join('')}</ul>`
        : '<p style="margin: 0; color: #64748b;">No specific reasons provided.</p>',
    )}
    ${notes ? emailSection('Additional notes', esc(notes)) : ''}
    ${emailButton(`https://portal.receptionmate.co.uk/calls/${encodeURIComponent(callId)}`, 'Review this call')}
  `);

  const text = `
NEGATIVE FEEDBACK RECEIVED

Branch: ${branchName}
Call ID: ${callId}
Submitted: ${formattedDate}
User: ${userEmail}

Reasons:
${reasons.length > 0 ? reasons.map(r => `• ${r}`).join('\n') : 'No specific reasons provided'}

${notes ? `Additional Notes:\n${notes}` : ''}

---
This is an automated alert from ReceptionMate
`;

  return sendEmail({
    to: ['hello@receptionmate.co.uk'],
    subject: `⚠️ Negative Feedback: ${branchName}`,
    html,
    text,
  });
};

interface NeedsAttentionEmailData {
  branchName: string;
  customerName: string | null;
  customerPhone: string | null;
  conversationId: string;
  recentMessages: Array<{ role: string; content: string }>;
}

export const sendNeedsAttentionEmail = async (
  notificationEmails: string[],
  data: NeedsAttentionEmailData,
): Promise<boolean> => {
  if (notificationEmails.length === 0) return false;

  const { branchName, customerName, customerPhone, conversationId, recentMessages } = data;
  const displayName = customerName || customerPhone || 'Unknown customer';
  const portalUrl = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';

  // Deep link into the inbox. The old /conversations/:id was never a route in this app, so
  // every "View Conversation in Portal" click until now landed on a 404.
  const conversationLink = `${portalUrl}/messages?conversation=${encodeURIComponent(conversationId)}`;

  const messagesHtml = recentMessages
    .map(m => {
      const label = m.role === 'user' ? 'Customer' : m.role === 'staff' ? 'Staff' : 'Agent';
      return `<tr><td style="padding: 0 0 10px;">` +
        `<div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: ${RM_FAINT}; padding-bottom: 3px;">${label}</div>` +
        `<div style="font-size: 14px; line-height: 1.5; color: ${RM_INK}; background-color: ${RM_WASH}; border: 1px solid ${RM_LINE}; border-radius: 8px; padding: 10px 12px;">${esc(m.content)}</div>` +
        `</td></tr>`;
    })
    .join('');

  const messagesText = recentMessages
    .map(m => {
      const label = m.role === 'user' ? 'Customer' : m.role === 'staff' ? 'Staff' : 'Agent';
      return `${label}: ${m.content}`;
    })
    .join('\n\n');

  const html = brandedEmailShell(`
    ${emailTitle('A customer needs attention', branchName, 'Handover', RM_BAD)}
    ${emailFacts([
      ['Customer', esc(displayName)],
      ['Phone', esc(customerPhone)],
    ])}
    ${emailSection(
      'Recent conversation',
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${messagesHtml}</table>`,
    )}
    ${emailButton(conversationLink, 'Open this conversation')}
  `);

  const text = `CUSTOMER NEEDS ATTENTION\n\nBranch: ${branchName}\nCustomer: ${displayName}${customerPhone ? `\nPhone: ${customerPhone}` : ''}\n\nRecent Conversation:\n${'─'.repeat(40)}\n${messagesText}\n\nView in portal: ${conversationLink}\n\n---\nReceptionMate automated notification`;

  return sendEmail({
    to: notificationEmails,
    subject: `Customer needs attention — ${displayName}`,
    html,
    text,
  });
};

interface WelcomeEmailData {
  to: string;
  businessName: string;
  branchName: string;
  email: string;
  password: string;
  portalUrl: string;
}

export const sendWelcomeEmail = async (data: WelcomeEmailData): Promise<boolean> => {
  const { to, businessName, branchName, email, password, portalUrl } = data;

  const html = brandedEmailShell(`
    ${emailTitle('Welcome to ReceptionMate', `${businessName} — ${branchName}`)}
    ${emailSection(null, '<p style="margin: 0;">Your account is set up and ready. Here are your login details.</p>')}
    ${emailFacts([
      ['Email', esc(email)],
      ['Password', `<span style="font-family: 'Courier New', monospace;">${esc(password)}</span>`],
    ])}
    ${emailCallout('You will be asked to change this password the first time you log in.', RM_WARN)}
    ${emailSection(
      'Next step',
      '<p style="margin: 0;">Once you are in, complete your Direct Debit mandate to activate the service. ' +
      'Until that is done your access stays limited.</p>',
    )}
    ${emailButton(`${portalUrl}/login`, 'Log in to the portal')}
    ${emailFootnote(`Need a hand? Email <a href="mailto:hello@receptionmate.co.uk" style="color: ${RM_BRAND}; text-decoration: none;">hello@receptionmate.co.uk</a>`)}
  `);

  const text = `
Welcome to ReceptionMate!

Your account has been created for ${businessName} - ${branchName}.

Your Login Credentials:
Email: ${email}
Password: ${password}

⚠️ Important: You will be required to change your password when you first log in.

💳 Set Up Direct Debit
After logging in, you'll need to complete your Direct Debit mandate to activate your service. This ensures uninterrupted access to ReceptionMate.

Log in to the portal: ${portalUrl}/login

If you have any questions or need assistance, please contact our support team at hello@receptionmate.co.uk

---
This is an automated email from ReceptionMate
`;

  return sendEmail({
    to: [to],
    subject: `Welcome to ReceptionMate - Your Login Credentials`,
    html,
    text,
  });
};

export const brandedEmailShell = (bodyHtml: string): string => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f1f2f9;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f1f2f9;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(52,38,207,0.12);">
          <tr>
            <td style="padding: 32px; background-color: ${RM_BRAND}; text-align: center;">
              <img src="${RM_LOGO_URL}" alt="ReceptionMate" height="120" style="height: 120px; width: auto; display: inline-block;" />
            </td>
          </tr>
          ${bodyHtml}
          <tr>
            <td style="padding: 24px 32px; background-color: #f7f7fb; border-top: 1px solid #e9eaf5;">
              <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #8b90b0; text-align: center;">
                This is an automated email from ReceptionMate<br/>
                © ${new Date().getFullYear()} ReceptionMate. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
