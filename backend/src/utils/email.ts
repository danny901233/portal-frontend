import nodemailer from 'nodemailer';
import type { TranscriptEntry } from './types.js';

export interface EmailAttachment {
  filename: string;
  content: Buffer | string;       // Buffer, or base64-encoded string when `encoding` is set
  encoding?: 'base64';
  contentType?: string;           // e.g. 'application/pdf'
}

interface EmailOptions {
  to: string[];
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

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

const sendViaMailgun = async (options: EmailOptions, config: ReturnType<typeof getMailgunConfig>): Promise<boolean> => {
  if (!config) {
    return false;
  }

  // Mailgun accepts either application/x-www-form-urlencoded (no attachments)
  // or multipart/form-data (with attachments). Use multipart whenever
  // attachments are present so the file bytes ride through correctly.
  const hasAttachments = (options.attachments?.length ?? 0) > 0;

  let body: BodyInit;
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`api:${config.apiKey}`).toString('base64')}`,
  };

  if (hasAttachments) {
    const form = new FormData();
    form.set('from', config.from);
    form.set('to', options.to.join(', '));
    form.set('subject', options.subject);
    form.set('text', options.text);
    form.set('html', options.html);
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
    form.set('from', config.from);
    form.set('to', options.to.join(', '));
    form.set('subject', options.subject);
    form.set('text', options.text);
    form.set('html', options.html);
    body = form.toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const response = await fetch(`${config.apiBase}/v3/${config.domain}/messages`, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error('Failed to send email via Mailgun:', response.status, errorBody);
    return false;
  }

  return true;
};

const sendViaO365 = async (options: EmailOptions, config: ReturnType<typeof getO365Config>): Promise<boolean> => {
  if (!config) {
    return false;
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

  await transport.sendMail({
    from: config.from,
    to: options.to.join(', '),
    subject: options.subject,
    text: options.text,
    html: options.html,
    attachments: options.attachments?.map((a) => ({
      filename: a.filename,
      content: a.encoding === 'base64' && typeof a.content === 'string'
        ? Buffer.from(a.content, 'base64')
        : a.content,
      contentType: a.contentType,
    })),
  });

  return true;
};

export const sendEmail = async (options: EmailOptions): Promise<boolean> => {
  const mailgunConfig = getMailgunConfig();
  const o365Config = getO365Config();

  if (!mailgunConfig && !o365Config) {
    console.warn('Email configuration missing. Configure Mailgun or O365 SMTP to enable sending.');
    return false;
  }

  if (mailgunConfig) {
    try {
      const sent = await sendViaMailgun(options, mailgunConfig);
      if (sent) {
        console.log(`Email sent successfully via Mailgun to: ${options.to.join(', ')}`);
        return true;
      }
      console.warn('Mailgun send failed, attempting O365 fallback.');
    } catch (error) {
      console.error('Failed to send email via Mailgun:', error);
      console.warn('Attempting O365 fallback.');
    }
  }

  if (o365Config) {
    try {
      const sent = await sendViaO365(options, o365Config);
      if (sent) {
        console.log(`Email sent successfully via O365 to: ${options.to.join(', ')}`);
        return true;
      }
    } catch (error) {
      console.error('Failed to send email via O365:', error);
      return false;
    }
  }

  console.warn('Email send failed and no fallback succeeded.');
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

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Call Summary - ${branchName}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #09203c;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #09203c;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; background-color: #1a3a52; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
          <!-- Header with Logo -->
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #3126cf 0%, #2419a8 100%);">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center; padding: 32px 32px 8px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                      <tr>
                        <td>
                          <img src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png" alt="ReceptionMate Logo" width="200" height="auto" style="display: block; border: 0; outline: none; text-decoration: none; max-width: 200px; height: auto;" />
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="text-align: center; padding: 16px 32px 32px;">
                    <h2 style="margin: 0; font-size: 20px; font-weight: 600; color: #ffffff;">
                      New Call Handled
                    </h2>
                    <p style="margin: 8px 0 0; font-size: 15px; color: rgba(255,255,255,0.95);">
                      ${branchName}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Call Details -->
          <tr>
            <td style="padding: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding-bottom: 20px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="background-color: #3126cf; color: #ffffff; padding: 8px 16px; border-radius: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">
                          ${callType}
                        </td>
                        ${confirmedBooking ? '<td style="padding-left: 8px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="background-color: #10b981; color: #ffffff; padding: 8px 16px; border-radius: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">✓ Booking Confirmed</td></tr></table></td>' : ''}
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 20px; background-color: #0d2739; border: 1px solid #1e4a66; border-radius: 8px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">📅 Call Date:</strong> ${formattedDate} at ${formattedTime}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">⏱️ Duration:</strong> ${formatDuration(durationSeconds)}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">👤 Customer Name:</strong> ${customerName || 'Not provided'}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">📞 Caller Phone:</strong> ${customerPhone || 'Not captured'}
                        </td>
                      </tr>
                      ${registrationNumber ? `
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">🚗 Registration:</strong> ${registrationNumber}
                        </td>
                      </tr>
                      ` : ''}
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">📆 Booking Date:</strong> ${formattedBookingDate || 'No booking made'}
                        </td>
                      </tr>
                      ${priceQuoted ? `
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">💰 Price Quoted:</strong> £${priceQuoted.toFixed(2)}
                        </td>
                      </tr>
                      ` : ''}
                      ${capturedRevenue ? `
                      <tr>
                        <td style="padding-bottom: 0; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #10b981;">💵 Revenue Captured:</strong> <span style="color: #10b981; font-weight: 600;">£${capturedRevenue.toFixed(2)}</span>
                        </td>
                      </tr>
                      ` : ''}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Summary -->
          <tr>
            <td style="padding: 0 32px 24px;">
              <h2 style="margin: 0 0 16px; font-size: 18px; font-weight: 700; color: #e2e8f0;">
                📋 Summary
              </h2>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding: 20px; background-color: #0d2739; border-left: 4px solid #3126cf; border-radius: 6px; font-size: 14px; line-height: 1.7; color: #cbd5e1;">
                    ${summary}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- View in Portal Button -->
          <tr>
            <td style="padding: 0 32px 32px; text-align: center;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                <tr>
                  <td style="background: linear-gradient(135deg, #3126cf 0%, #2419a8 100%); border-radius: 8px; padding: 16px 40px;">
                    <a href="https://portal.receptionmate.co.uk/calls" style="color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; display: block;">
                      🎧 View Call Recording & Transcript in Portal
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin: 16px 0 0; font-size: 13px; color: #94a3b8;">
                Listen to the full recording and read the complete transcript
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 28px 32px; background-color: #0a1929; border-top: 1px solid #1e4a66; text-align: center;">
              <p style="margin: 0; font-size: 13px; color: #cbd5e1; font-weight: 500;">
                This is an automated notification from <strong style="color: #3126cf;">ReceptionMate</strong>
              </p>
              <p style="margin: 12px 0 0; font-size: 12px; color: #64748b;">
                Intelligent call handling for your business
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
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

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Action Required: Set Up Direct Debit</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #09203c;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #09203c;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; background-color: #1a3a52; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center; padding: 32px;">
                    <h2 style="margin: 0; font-size: 24px; font-weight: 600; color: #ffffff;">
                      ⚠️ Action Required: Direct Debit Setup
                    </h2>
                    <p style="margin: 8px 0 0; font-size: 15px; color: rgba(255,255,255,0.95);">
                      ${data.branchName}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding: 0 0 24px; font-size: 16px; line-height: 1.6; color: #e2e8f0;">
                    <p style="margin: 0 0 16px;">
                      <strong>Good news!</strong> ReceptionMate handled a call for you on ${formattedDate}.
                    </p>
                    <p style="margin: 0 0 16px;">
                      However, we noticed that your Direct Debit mandate is not currently active. To ensure uninterrupted service and receive full call details, please complete your payment setup.
                    </p>
                  </td>
                </tr>

                <tr>
                  <td style="padding: 20px; background-color: #0d2739; border: 1px solid #1e4a66; border-radius: 8px; margin-bottom: 24px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 0; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">📞 Call Received:</strong> ${formattedDate}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="padding: 24px 0;">
                    <div style="background-color: #0d2739; border-left: 4px solid #f59e0b; padding: 16px 20px; border-radius: 4px;">
                      <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #fbbf24;">
                        <strong>⚠️ Important:</strong> To continue receiving full call details and maintain uninterrupted service, please set up your Direct Debit mandate as soon as possible.
                      </p>
                    </div>
                  </td>
                </tr>

                <tr>
                  <td style="text-align: center; padding: 32px 0 0;">
                    <a href="${data.portalUrl}/login" style="display: inline-block; padding: 16px 32px; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);">
                      Complete Direct Debit Setup
                    </a>
                  </td>
                </tr>

                <tr>
                  <td style="padding: 24px 0 0; font-size: 14px; line-height: 1.6; color: #94a3b8; text-align: center;">
                    <p style="margin: 0;">
                      Questions? Contact us at <a href="mailto:hello@receptionmate.co.uk" style="color: #3b82f6; text-decoration: none;">hello@receptionmate.co.uk</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding: 24px 32px; background-color: #0d2739; border-top: 1px solid #1e4a66;">
              <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #64748b; text-align: center;">
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
 * Shared branded shell for transactional emails: white card on light grey, an indigo header
 * band carrying the ReceptionMate logo, and a consistent footer. Callers pass the inner
 * body HTML. Keeps every email on-brand with the portal / marketing site.
 *
 * (Was arrearsEmailShell — nothing about it is arrears-specific, and the agreement email needs
 * the same shell. NB sendWelcomeEmail still uses an older dark-navy template with a logo on the
 * WordPress site; that one is stale and should be migrated here too.)
 */
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

/**
 * Arrears notice — sent instead of the full call summary when a garage is flagged
 * accessRestricted. Deliberately contains NO call content (no caller, summary, transcript
 * or recording): it only confirms a call was handled and that the details are on hold
 * until the account is brought up to date.
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

  const html = brandedEmailShell(`
          <tr>
            <td style="padding: 36px 32px 8px; text-align: center;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 600; color: #1d1a72;">📞 We handled a call for you</h1>
              <p style="margin: 8px 0 0; font-size: 15px; color: #6b7194;">${data.branchName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px 0;">
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #3a3f5c;">
                Your ReceptionMate AI receptionist answered a call for you on <strong>${formattedDate}</strong>.
              </p>
              <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.6; color: #3a3f5c;">
                Your account is currently <strong>in arrears</strong>, so the caller's details, the call summary,
                transcript and recording are <strong>on hold</strong>. As soon as your account is brought up to
                date, everything will be unlocked in your portal.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding: 16px 20px; background-color: #fff8ec; border: 1px solid #f6dfae; border-radius: 10px; font-size: 14px; line-height: 1.5; color: #8a6417;">
                    <strong>📞 Call handled:</strong> ${formattedDate}<br/>
                    <strong>🔒 Details:</strong> locked until your account is up to date
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 32px 4px; text-align: center;">
              <a href="${data.portalUrl}/login" style="display: inline-block; padding: 14px 30px; background-color: ${RM_BRAND}; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 10px;">
                Bring my account up to date
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
WE HANDLED A CALL FOR YOU

${data.branchName}

Your ReceptionMate AI receptionist answered a call for you on ${formattedDate}.

Your account is currently IN ARREARS, so the caller's details, the call summary, transcript and recording are on hold. As soon as your account is brought up to date, everything will be unlocked in your portal.

Call handled: ${formattedDate}
Details: locked until your account is up to date

Bring your account up to date: ${data.portalUrl}/login

Questions? Contact us at hello@receptionmate.co.uk

---
This is an automated email from ReceptionMate
`;

  return sendEmail({
    to: notificationEmails,
    subject: 'We handled a call for you — account update needed',
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
export const sendArrearsWarningEmail = async (
  recipients: string[],
  data: ArrearsWarningEmailData,
): Promise<boolean> => {
  if (recipients.length === 0) {
    console.log('No recipients configured for arrears warning email');
    return false;
  }

  const html = brandedEmailShell(`
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

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Negative Feedback Alert</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #09203c;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #09203c;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; background-color: #1a3a52; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center; padding: 32px;">
                    <h2 style="margin: 0; font-size: 24px; font-weight: 600; color: #ffffff;">
                      ⚠️ Negative Feedback Received
                    </h2>
                    <p style="margin: 8px 0 0; font-size: 15px; color: rgba(255,255,255,0.95);">
                      ${branchName}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding: 20px; background-color: #0d2739; border: 1px solid #1e4a66; border-radius: 8px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">📅 Submitted:</strong> ${formattedDate}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">👤 User:</strong> ${userEmail}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">🆔 Call ID:</strong> ${callId}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">📝 Reasons:</strong><br/>
                          ${reasons.length > 0 ? reasons.map(r => `• ${r}`).join('<br/>') : 'No specific reasons provided'}
                        </td>
                      </tr>
                      ${notes ? `<tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">💬 Additional Notes:</strong><br/>
                          ${notes}
                        </td>
                      </tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 32px; text-align: center; color: #64748b; font-size: 12px; border-top: 1px solid #1e4a66;">
              <p style="margin: 0;">
                This is an automated alert from ReceptionMate
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

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

  const messagesHtml = recentMessages
    .map(m => {
      const label = m.role === 'user' ? '👤 Customer' : m.role === 'staff' ? '🧑 Staff' : '🤖 Agent';
      return `<tr><td style="padding: 8px 0; font-size: 14px; color: #94a3b8;"><strong style="color: #e2e8f0;">${label}:</strong> ${m.content}</td></tr>`;
    })
    .join('');

  const messagesText = recentMessages
    .map(m => {
      const label = m.role === 'user' ? 'Customer' : m.role === 'staff' ? 'Staff' : 'Agent';
      return `${label}: ${m.content}`;
    })
    .join('\n\n');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#09203c;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#09203c;">
    <tr><td style="padding:40px 20px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin:0 auto;background-color:#1a3a52;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.5);">
        <tr><td style="background:linear-gradient(135deg,#dc2626 0%,#b91c1c 100%);text-align:center;padding:32px;">
          <h2 style="margin:0;font-size:22px;font-weight:600;color:#ffffff;">⚠️ Customer Needs Attention</h2>
          <p style="margin:8px 0 0;font-size:15px;color:rgba(255,255,255,0.95);">${branchName}</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr><td style="padding:20px;background-color:#0d2739;border:1px solid #1e4a66;border-radius:8px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr><td style="padding-bottom:12px;font-size:14px;color:#94a3b8;"><strong style="color:#e2e8f0;">👤 Customer:</strong> ${displayName}</td></tr>
                ${customerPhone ? `<tr><td style="padding-bottom:12px;font-size:14px;color:#94a3b8;"><strong style="color:#e2e8f0;">📞 Phone:</strong> ${customerPhone}</td></tr>` : ''}
              </table>
            </td></tr>
          </table>
          <h3 style="margin:24px 0 12px;font-size:16px;font-weight:600;color:#e2e8f0;">Recent Conversation</h3>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#0d2739;border-left:4px solid #dc2626;border-radius:6px;">
            <tr><td style="padding:16px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                ${messagesHtml}
              </table>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:0 32px 32px;text-align:center;">
          <a href="${portalUrl}/conversations/${conversationId}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#3126cf 0%,#2419a8 100%);color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">View Conversation in Portal</a>
        </td></tr>
        <tr><td style="padding:24px;background-color:#0d2739;border-top:1px solid #1e4a66;text-align:center;">
          <p style="margin:0;font-size:12px;color:#64748b;">Automated notification from <strong style="color:#3126cf;">ReceptionMate</strong></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `CUSTOMER NEEDS ATTENTION\n\nBranch: ${branchName}\nCustomer: ${displayName}${customerPhone ? `\nPhone: ${customerPhone}` : ''}\n\nRecent Conversation:\n${'─'.repeat(40)}\n${messagesText}\n\nView in portal: ${portalUrl}/conversations/${conversationId}\n\n---\nReceptionMate automated notification`;

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
  const esc = (v: string) =>
    String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const html = brandedEmailShell(`
          <tr>
            <td style="padding: 32px;">
              <h1 style="margin: 0 0 20px; font-size: 22px; font-weight: 700; color: #1a1a2e;">Your ReceptionMate account is ready</h1>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4a4a68;">Hi there,</p>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4a4a68;">
                Your AI receptionist is built and your account is set up for
                <strong style="color: #1a1a2e;">${esc(businessName)}</strong> — <strong style="color: #1a1a2e;">${esc(branchName)}</strong>.
                Here's how to log in.
              </p>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding: 20px; background-color: #f7f7fb; border: 1px solid #e6e7f2; border-radius: 10px;">
                    <h2 style="margin: 0 0 14px; font-size: 15px; font-weight: 600; color: #1a1a2e;">Your login details</h2>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding: 6px 0; font-size: 14px; color: #8b90b0; width: 90px;">Email</td>
                        <td style="padding: 6px 0; font-size: 14px; color: #1a1a2e; font-weight: 500;">${esc(email)}</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; font-size: 14px; color: #8b90b0;">Password</td>
                        <td style="padding: 6px 0; font-size: 14px; color: #1a1a2e; font-weight: 600; font-family: 'Courier New', monospace;">${esc(password)}</td>
                      </tr>
                    </table>
                    <p style="margin: 14px 0 0; font-size: 13px; line-height: 1.5; color: #8b90b0;">
                      You'll be asked to choose your own password the first time you log in.
                    </p>
                  </td>
                </tr>
              </table>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center; padding: 24px 0;">
                    <a href="${portalUrl}/login" style="display: inline-block; padding: 14px 32px; background-color: ${RM_BRAND}; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px;">Log in to your portal</a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 8px; font-size: 15px; line-height: 1.6; color: #4a4a68;">
                <strong style="color: #1a1a2e;">Two things to do once you're in:</strong>
              </p>
              <p style="margin: 0 0 8px; font-size: 15px; line-height: 1.6; color: #4a4a68;">
                <strong style="color: #1a1a2e;">1. Finish your setup</strong> — check your opening hours, greeting and FAQs so your receptionist answers the way you want.
              </p>
              <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #4a4a68;">
                <strong style="color: #1a1a2e;">2. Set up your Direct Debit</strong> — this activates your service.
              </p>

              <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #8b90b0;">
                Any questions, just reply to this email or contact <a href="mailto:hello@receptionmate.co.uk" style="color: ${RM_BRAND}; text-decoration: none;">hello@receptionmate.co.uk</a>.
              </p>
            </td>
          </tr>`);

  const text = `Hi there,

Your AI receptionist is built and your account is set up for ${businessName} — ${branchName}.

Your login details
Email: ${email}
Password: ${password}

You'll be asked to choose your own password the first time you log in.

Log in: ${portalUrl}/login

Two things to do once you're in:
1. Finish your setup — check your opening hours, greeting and FAQs.
2. Set up your Direct Debit — this activates your service.

Any questions, just reply to this email or contact hello@receptionmate.co.uk.
`;

  return sendEmail({
    to: [to],
    subject: 'Your ReceptionMate account is ready',
    html,
    text,
  });
};

export interface AgreementSignEmailData {
  to: string;
  clientName: string;
  signUrl: string;
}

/**
 * "Your agreement is ready to sign" — the first email a sales-led customer receives from us, so
 * it uses the shared branded shell (white card, indigo header, logo).
 *
 * Deliberately does NOT restate the commercial terms: they're in the agreement being opened, and
 * duplicating them here just adds a second place to keep correct.
 */
export const sendAgreementSignEmail = async (data: AgreementSignEmailData): Promise<boolean> => {
  const { to, clientName, signUrl } = data;
  const esc = (v: string) =>
    String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const html = brandedEmailShell(`
          <tr>
            <td style="padding: 32px;">
              <h1 style="margin: 0 0 20px; font-size: 22px; font-weight: 700; color: #1a1a2e;">Your agreement is ready to sign</h1>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #4a4a68;">Hi ${esc(clientName)},</p>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #4a4a68;">
                Your ReceptionMate service agreement is ready. Have a read through and sign it online — it takes about a minute, and there's nothing to print or scan.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center; padding: 4px 0 24px;">
                    <a href="${signUrl}" style="display: inline-block; padding: 14px 32px; background-color: ${RM_BRAND}; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px;">Review and sign</a>
                  </td>
                </tr>
              </table>
              <p style="margin: 0 0 20px; font-size: 14px; line-height: 1.6; color: #8b90b0;">
                This link is valid for 14 days and is unique to you — please don't forward it.
              </p>
              <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #4a4a68;">
                <strong style="color: #1a1a2e;">What happens next:</strong> once you've signed, we'll set up your integration and build your AI receptionist. We'll email your login details as soon as it's ready — nothing needed from you in the meantime.
              </p>
              <p style="margin: 24px 0 0; font-size: 14px; line-height: 1.6; color: #8b90b0;">
                Any questions, just reply to this email or contact <a href="mailto:hello@receptionmate.co.uk" style="color: ${RM_BRAND}; text-decoration: none;">hello@receptionmate.co.uk</a>.
              </p>
            </td>
          </tr>`);

  const text = `Hi ${clientName},

Your ReceptionMate service agreement is ready to sign.

Review and sign here: ${signUrl}

This link is valid for 14 days and is unique to you — please don't forward it.

What happens next: once you've signed, we'll set up your integration and build your AI receptionist. We'll email your login details as soon as it's ready.

Any questions, reply to this email or contact hello@receptionmate.co.uk

— The ReceptionMate team
`;

  return sendEmail({ to: [to], subject: 'Your ReceptionMate agreement is ready to sign', html, text });
};
