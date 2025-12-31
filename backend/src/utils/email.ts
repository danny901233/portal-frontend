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

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Call Summary - ${branchName}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f5f5f5;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 32px 32px 24px; background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; font-size: 24px; font-weight: 600; color: #ffffff;">
                ReceptionMate Handled A Call
              </h1>
              <p style="margin: 8px 0 0; font-size: 14px; color: rgba(255,255,255,0.9);">
                ${branchName}
              </p>
            </td>
          </tr>
          
          <!-- Call Details -->
          <tr>
            <td style="padding: 24px 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding-bottom: 16px;">
                    <div style="display: inline-block; padding: 4px 12px; background-color: #e0f2fe; color: #0369a1; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase;">
                      ${callType}
                    </div>
                    ${confirmedBooking ? '<div style="display: inline-block; margin-left: 8px; padding: 4px 12px; background-color: #dcfce7; color: #166534; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase;">Confirmed Booking</div>' : ''}
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom: 8px; font-size: 14px; color: #64748b;">
                    <strong style="color: #334155;">Date:</strong> ${formattedDate} at ${formattedTime}
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom: 8px; font-size: 14px; color: #64748b;">
                    <strong style="color: #334155;">Duration:</strong> ${formatDuration(durationSeconds)}
                  </td>
                </tr>
                ${customerName ? `
                <tr>
                  <td style="padding-bottom: 8px; font-size: 14px; color: #64748b;">
                    <strong style="color: #334155;">Customer:</strong> ${customerName}
                  </td>
                </tr>
                ` : ''}
                ${customerPhone ? `
                <tr>
                  <td style="padding-bottom: 8px; font-size: 14px; color: #64748b;">
                    <strong style="color: #334155;">Phone:</strong> ${customerPhone}
                  </td>
                </tr>
                ` : ''}
                ${registrationNumber ? `
                <tr>
                  <td style="padding-bottom: 8px; font-size: 14px; color: #64748b;">
                    <strong style="color: #334155;">Registration:</strong> ${registrationNumber}
                  </td>
                </tr>
                ` : ''}
                ${capturedRevenue ? `
                <tr>
                  <td style="padding-bottom: 8px; font-size: 14px; color: #64748b;">
                    <strong style="color: #334155;">Revenue:</strong> £${capturedRevenue.toFixed(2)}
                  </td>
                </tr>
                ` : ''}
              </table>
            </td>
          </tr>
          
          <!-- Summary -->
          <tr>
            <td style="padding: 0 32px 24px;">
              <h2 style="margin: 0 0 12px; font-size: 16px; font-weight: 600; color: #1e293b;">
                Summary
              </h2>
              <div style="padding: 16px; background-color: #f8fafc; border-left: 3px solid #0ea5e9; border-radius: 4px; font-size: 14px; line-height: 1.6; color: #475569;">
                ${summary}
              </div>
            </td>
          </tr>
          
          <!-- Transcript -->
          <tr>
            <td style="padding: 0 32px 32px;">
              <h2 style="margin: 0 0 12px; font-size: 16px; font-weight: 600; color: #1e293b;">
                Full Transcript
              </h2>
              <div style="padding: 16px; background-color: #f8fafc; border-radius: 4px; font-size: 13px; line-height: 1.8; color: #64748b; white-space: pre-wrap; font-family: 'Courier New', monospace;">
${formatTranscript(transcript)}
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; background-color: #f8fafc; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; color: #94a3b8;">
              <p style="margin: 0;">
                This is an automated notification from ReceptionMate
              </p>
              <p style="margin: 8px 0 0;">
                For support, visit your portal dashboard
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

  let text = `ReceptionMate Handled A Call for you\n`;
  text += `${'='.repeat(50)}\n\n`;
  text += `Branch: ${branchName}\n`;
  text += `Date: ${formattedDate} at ${formattedTime}\n`;
  text += `Duration: ${formatDuration(durationSeconds)}\n`;
  text += `Call Type: ${callType}\n`;
  
  if (confirmedBooking) {
    text += `Status: CONFIRMED BOOKING\n`;
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
  
  if (capturedRevenue) {
    text += `Revenue: £${capturedRevenue.toFixed(2)}\n`;
  }
  
  text += `\nSummary:\n`;
  text += `${'-'.repeat(50)}\n`;
  text += `${summary}\n\n`;
  
  text += `Full Transcript:\n`;
  text += `${'-'.repeat(50)}\n`;
  text += `${formatTranscript(transcript)}\n\n`;
  
  text += `${'='.repeat(50)}\n`;
  text += `This is an automated notification from ReceptionMate\n`;
  
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
