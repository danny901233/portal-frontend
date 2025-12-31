import nodemailer from 'nodemailer';
import type { TranscriptEntry } from './types.js';

interface EmailOptions {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

const createTransporter = () => {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || smtpUser;

  if (!smtpHost || !smtpUser || !smtpPass) {
    console.error('Email configuration missing. Set SMTP_HOST, SMTP_USER, and SMTP_PASS environment variables.');
    return null;
  }

  return nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
    from: smtpFrom,
  });
};

export const sendEmail = async (options: EmailOptions): Promise<boolean> => {
  const transporter = createTransporter();
  
  if (!transporter) {
    console.warn('Email transporter not configured, skipping email send');
    return false;
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: options.to.join(', '),
      subject: options.subject,
      text: options.text,
      html: options.html,
    });
    
    console.log(`Email sent successfully to: ${options.to.join(', ')}`);
    return true;
  } catch (error) {
    console.error('Failed to send email:', error);
    return false;
  }
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
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #0f172a;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #0f172a;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; background-color: #1e293b; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.3);">
          <!-- Header with Logo -->
          <tr>
            <td style="padding: 40px 32px 32px; background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); border-radius: 12px 12px 0 0;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center; padding-bottom: 24px;">
                    <div style="display: inline-block; padding: 12px 24px; background-color: rgba(255,255,255,0.15); border-radius: 8px; backdrop-filter: blur(10px);">
                      <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px;">
                        ReceptionMate
                      </h1>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="text-align: center;">
                    <h2 style="margin: 0; font-size: 20px; font-weight: 600; color: #ffffff;">
                      New Call Handled
                    </h2>
                    <p style="margin: 8px 0 0; font-size: 15px; color: rgba(255,255,255,0.9);">
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
                    <div style="display: inline-block; padding: 6px 14px; background-color: #0ea5e9; color: #ffffff; border-radius: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">
                      ${callType}
                    </div>
                    ${confirmedBooking ? '<div style="display: inline-block; margin-left: 8px; padding: 6px 14px; background-color: #10b981; color: #ffffff; border-radius: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">✓ Booking Confirmed</div>' : ''}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 20px; background-color: #0f172a; border-radius: 8px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">📅 Call Date:</strong> ${formattedDate} at ${formattedTime}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">⏱️ Duration:</strong> ${formatDuration(durationSeconds)}
                        </td>
                      </tr>
                      ${customerName ? `
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">👤 Customer:</strong> ${customerName}
                        </td>
                      </tr>
                      ` : ''}
                      ${customerPhone ? `
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">📞 Phone:</strong> ${customerPhone}
                        </td>
                      </tr>
                      ` : ''}
                      ${registrationNumber ? `
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">🚗 Registration:</strong> ${registrationNumber}
                        </td>
                      </tr>
                      ` : ''}
                      ${formattedBookingDate ? `
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">📆 Booking Date:</strong> ${formattedBookingDate}
                        </td>
                      </tr>
                      ` : ''}
                      ${priceQuoted ? `
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">💰 Price Quoted:</strong> £${priceQuoted.toFixed(2)}
                        </td>
                      </tr>
                      ` : ''}
                      ${capturedRevenue ? `
                      <tr>
                        <td style="padding-bottom: 0; font-size: 14px; color: #94a3b8;">
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
              <h2 style="margin: 0 0 16px; font-size: 18px; font-weight: 700; color: #f1f5f9;">
                📋 Call Summary
              </h2>
              <div style="padding: 20px; background-color: #0f172a; border-left: 4px solid #0ea5e9; border-radius: 6px; font-size: 14px; line-height: 1.7; color: #cbd5e1;">
                ${summary}
              </div>
            </td>
          </tr>
          
          <!-- Transcript -->
          <tr>
            <td style="padding: 0 32px 32px;">
              <h2 style="margin: 0 0 16px; font-size: 18px; font-weight: 700; color: #f1f5f9;">
                💬 Full Transcript
              </h2>
              <div style="padding: 20px; background-color: #0f172a; border-radius: 6px; font-size: 13px; line-height: 1.9; color: #94a3b8; white-space: pre-wrap; font-family: 'Courier New', Consolas, monospace; max-height: 400px; overflow-y: auto;">
${formatTranscript(transcript)}
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 28px 32px; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); border-radius: 0 0 12px 12px; text-align: center;">
              <p style="margin: 0; font-size: 13px; color: #cbd5e1; font-weight: 500;">
                This is an automated notification from <strong style="color: #0ea5e9;">ReceptionMate</strong>
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
