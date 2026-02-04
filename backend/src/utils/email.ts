import nodemailer from 'nodemailer';
import type { TranscriptEntry } from './types.js';

interface EmailOptions {
  to: string[];
  subject: string;
  html: string;
  text: string;
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

  const form = new URLSearchParams();
  form.set('from', config.from);
  form.set('to', options.to.join(', '));
  form.set('subject', options.subject);
  form.set('text', options.text);
  form.set('html', options.html);

  const response = await fetch(`${config.apiBase}/v3/${config.domain}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${config.apiKey}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
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

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to ReceptionMate</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #09203c;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #09203c;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; background-color: #1a3a52; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center; padding: 32px;">
                    <h2 style="margin: 0; font-size: 24px; font-weight: 600; color: #ffffff;">
                      🎉 Welcome to ReceptionMate!
                    </h2>
                    <p style="margin: 8px 0 0; font-size: 15px; color: rgba(255,255,255,0.95);">
                      Your account has been created
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding: 32px;">
              <p style="margin: 0 0 20px; font-size: 16px; color: #cbd5e1; line-height: 1.6;">
                Hi there,
              </p>

              <p style="margin: 0 0 20px; font-size: 16px; color: #cbd5e1; line-height: 1.6;">
                Your ReceptionMate account has been set up for <strong style="color: #ffffff;">${businessName}</strong> - <strong style="color: #ffffff;">${branchName}</strong>.
              </p>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding: 20px; background-color: #0d2739; border: 1px solid #1e4a66; border-radius: 8px;">
                    <h3 style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #ffffff;">
                      Your Login Credentials
                    </h3>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding: 8px 0; font-size: 14px; color: #94a3b8; width: 120px;">Email:</td>
                        <td style="padding: 8px 0; font-size: 14px; color: #ffffff; font-weight: 500;">${email}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; font-size: 14px; color: #94a3b8;">Password:</td>
                        <td style="padding: 8px 0; font-size: 14px; color: #ffffff; font-weight: 500; font-family: 'Courier New', monospace;">${password}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin: 20px 0; font-size: 14px; color: #94a3b8; line-height: 1.6;">
                <strong style="color: #fbbf24;">⚠️ Important:</strong> You will be required to change your password when you first log in.
              </p>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center; padding: 20px 0;">
                    <a href="${portalUrl}/login" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                      Log In to Portal
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 20px 0 0; font-size: 14px; color: #94a3b8; line-height: 1.6;">
                If you have any questions or need assistance, please don't hesitate to contact our support team.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding: 24px; background-color: #0d2739; border-top: 1px solid #1e4a66;">
              <p style="margin: 0; font-size: 12px; color: #64748b; text-align: center;">
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
</html>
`;

  const text = `
Welcome to ReceptionMate!

Your account has been created for ${businessName} - ${branchName}.

Your Login Credentials:
Email: ${email}
Password: ${password}

⚠️ Important: You will be required to change your password when you first log in.

Log in to the portal: ${portalUrl}/login

If you have any questions or need assistance, please contact our support team.

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
