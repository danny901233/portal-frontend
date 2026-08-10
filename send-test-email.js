const nodemailer = require('nodemailer');
require('dotenv').config();

const portalUrl = 'https://portal.receptionmate.co.uk';
const branchName = 'Test Garage';
const summary = 'Customer called regarding booking a service';
const customerPhone = '+447976500282';
const createdAt = new Date().toISOString();

const date = new Date(createdAt);
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
                  <td style="padding: 0 0 24px; font-size: 16px; line-height: 1.6; color: #e2e8f0;">
                    <p style="margin: 0 0 16px;">
                      <strong>Good news!</strong> ReceptionMate captured a call for you on ${formattedDate}.
                    </p>
                    <p style="margin: 0 0 16px;">
                      However, we noticed that your Direct Debit mandate is not yet set up. To ensure uninterrupted service and receive full call details, please complete your payment setup.
                    </p>
                  </td>
                </tr>

                <tr>
                  <td style="padding: 20px; background-color: #0d2739; border: 1px solid #1e4a66; border-radius: 8px; margin-bottom: 24px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">📞 Call Received:</strong> ${formattedDate}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 12px; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">From:</strong> ${customerPhone}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 0; font-size: 14px; line-height: 1.5; color: #94a3b8;">
                          <strong style="color: #e2e8f0;">Summary:</strong> ${summary}
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
                    <a href="${portalUrl}/login" style="display: inline-block; padding: 16px 32px; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);">
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

${branchName}

Good news! ReceptionMate captured a call for you on ${formattedDate}.

However, we noticed that your Direct Debit mandate is not yet set up. To ensure uninterrupted service and receive full call details, please complete your payment setup.

CALL DETAILS:
📞 Call Received: ${formattedDate}
From: ${customerPhone}
Summary: ${summary}

⚠️ IMPORTANT:
To continue receiving full call details and maintain uninterrupted service, please set up your Direct Debit mandate as soon as possible.

Complete your setup here: ${portalUrl}/login

Questions? Contact us at hello@receptionmate.co.uk

---
This is an automated email from ReceptionMate
`;

// Send via Office 365
const transporter = nodemailer.createTransport({
  host: process.env.O365_SMTP_HOST || 'smtp.office365.com',
  port: Number(process.env.O365_SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.O365_SMTP_USER,
    pass: process.env.O365_SMTP_PASS,
  },
});

const mailOptions = {
  from: process.env.O365_FROM || process.env.O365_SMTP_USER,
  to: 'dan@receptionmate.co.uk',
  subject: '⚠️ Action Required: Set Up Direct Debit - Call Captured',
  html,
  text,
};

transporter.sendMail(mailOptions, (error, info) => {
  if (error) {
    console.log('Error sending email:', error);
  } else {
    console.log('Email sent successfully:', info.messageId);
  }
});
