const fs = require('fs');

// Load .env manually
const envPath = '/home/ec2-user/portal-backend/.env';
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      process.env[match[1]] = match[2];
    }
  });
}

// Use Mailgun API
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN;
const MAILGUN_FROM = process.env.MAILGUN_FROM;
const MAILGUN_API_BASE = (process.env.MAILGUN_API_BASE || 'https://api.mailgun.net').replace(/\/$/, '');

const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Test</title></head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #09203c;">
  <table width="100%" style="background-color: #09203c;">
    <tr><td style="padding: 40px 20px;">
      <table width="600" style="margin: 0 auto; background-color: #1a3a52; border-radius: 12px;">
        <tr><td style="padding: 0; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);">
          <table width="100%"><tr><td style="text-align: center; padding: 32px;">
            <h2 style="margin: 0; font-size: 24px; color: #ffffff;">⚠️ Action Required: Direct Debit Setup</h2>
            <p style="margin: 8px 0 0; font-size: 15px; color: rgba(255,255,255,0.95);">Test Garage</p>
          </td></tr></table>
        </td></tr>
        <tr><td style="padding: 32px;">
          <p style="font-size: 16px; color: #e2e8f0;"><strong>Good news!</strong> ReceptionMate captured a call for you on 26 Mar 2026, 15:30.</p>
          <p style="font-size: 16px; color: #e2e8f0;">However, your Direct Debit mandate is not yet set up. Please complete your payment setup to receive full call details.</p>
          <div style="padding: 20px; background-color: #0d2739; border: 1px solid #1e4a66; border-radius: 8px; margin: 20px 0;">
            <p style="font-size: 14px; color: #94a3b8; margin: 8px 0;"><strong style="color: #e2e8f0;">📞 Call Received:</strong> 26 Mar 2026, 15:30</p>
            <p style="font-size: 14px; color: #94a3b8; margin: 8px 0;"><strong style="color: #e2e8f0;">From:</strong> +447976500282</p>
            <p style="font-size: 14px; color: #94a3b8; margin: 8px 0;"><strong style="color: #e2e8f0;">Summary:</strong> Customer called regarding booking a service</p>
          </div>
          <div style="background-color: #0d2739; border-left: 4px solid #f59e0b; padding: 16px 20px; border-radius: 4px; margin: 24px 0;">
            <p style="margin: 0; font-size: 15px; color: #fbbf24;"><strong>⚠️ Important:</strong> To continue receiving full call details and maintain uninterrupted service, please set up your Direct Debit mandate as soon as possible.</p>
          </div>
          <div style="text-align: center; padding: 32px 0;">
            <a href="https://portal.receptionmate.co.uk/login" style="display: inline-block; padding: 16px 32px; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">Complete Direct Debit Setup</a>
          </div>
          <p style="font-size: 14px; color: #94a3b8; text-align: center;">Questions? Contact us at <a href="mailto:hello@receptionmate.co.uk" style="color: #3b82f6;">hello@receptionmate.co.uk</a></p>
        </td></tr>
        <tr><td style="padding: 24px 32px; background-color: #0d2739; border-top: 1px solid #1e4a66;">
          <p style="margin: 0; font-size: 12px; color: #64748b; text-align: center;">This is an automated email from ReceptionMate<br/>© 2026 ReceptionMate. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

const text = `⚠️ ACTION REQUIRED: DIRECT DEBIT SETUP

Test Garage

Good news! ReceptionMate captured a call for you on 26 Mar 2026.

However, your Direct Debit mandate is not yet set up. To ensure uninterrupted service and receive full call details, please complete your payment setup.

CALL DETAILS:
📞 Call Received: 26 Mar 2026, 15:30
From: +447976500282
Summary: Customer called regarding booking a service

⚠️ IMPORTANT:
To continue receiving full call details and maintain uninterrupted service, please set up your Direct Debit mandate as soon as possible.

Complete your setup here: https://portal.receptionmate.co.uk/login

Questions? Contact us at hello@receptionmate.co.uk`;

// Send via Mailgun
const form = new URLSearchParams();
form.set('from', MAILGUN_FROM);
form.set('to', 'dan@receptionmate.co.uk');
form.set('subject', '⚠️ Action Required: Set Up Direct Debit - Call Captured');
form.set('text', text);
form.set('html', html);

const url = `${MAILGUN_API_BASE}/v3/${MAILGUN_DOMAIN}/messages`;
const auth = 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64');

fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': auth,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: form.toString(),
})
  .then(response => response.json())
  .then(data => {
    console.log('✅ Email sent successfully to dan@receptionmate.co.uk');
    console.log('Mailgun response:', data);
  })
  .catch(error => {
    console.error('Error sending email:', error);
    process.exit(1);
  });
