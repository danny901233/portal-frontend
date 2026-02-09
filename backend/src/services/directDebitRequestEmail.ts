import { sendEmail } from '../utils/email.js';

/**
 * Send Direct Debit setup request email to a user
 */
export async function sendDirectDebitRequestEmail(
  userEmail: string,
  userName: string | null,
  garageNames: string[]
): Promise<void> {
  const portalUrl = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';
  const setupUrl = `${portalUrl}/setup-payment`;

  const emailHtml = generateDirectDebitRequestHtml(userName || userEmail, garageNames, setupUrl);
  const emailText = generateDirectDebitRequestText(userName || userEmail, garageNames, setupUrl);

  await sendEmail({
    to: [userEmail],
    subject: 'Action Required: Set Up Direct Debit for ReceptionMate',
    html: emailHtml,
    text: emailText,
  });

  console.log(`✓ Direct Debit request email sent to ${userEmail}`);
}

/**
 * Generate HTML email for Direct Debit request
 */
function generateDirectDebitRequestHtml(
  userName: string,
  garageNames: string[],
  setupUrl: string
): string {
  const garagesList = garageNames.map(name => `<li style="margin: 4px 0;">${name}</li>`).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8fafc; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 30px 40px; border-bottom: 2px solid #e2e8f0;">
              <h1 style="margin: 0 0 10px 0; color: #0f172a; font-size: 24px; font-weight: 600;">
                Set Up Your Direct Debit
              </h1>
              <p style="margin: 0; color: #64748b; font-size: 14px;">
                Complete your ReceptionMate setup
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 30px 40px;">
              <p style="margin: 0 0 16px 0; color: #334155; font-size: 16px; line-height: 1.6;">
                Hi ${userName},
              </p>

              <p style="margin: 0 0 16px 0; color: #334155; font-size: 16px; line-height: 1.6;">
                To complete your ReceptionMate setup and start using your AI phone answering service, we need you to set up Direct Debit for automatic billing.
              </p>

              ${garageNames.length > 0 ? `
              <p style="margin: 0 0 8px 0; color: #334155; font-size: 14px; font-weight: 600;">
                Your branch${garageNames.length > 1 ? 'es' : ''}:
              </p>
              <ul style="margin: 0 0 20px 0; padding-left: 20px; color: #475569;">
                ${garagesList}
              </ul>
              ` : ''}

              <div style="margin: 24px 0; text-align: center;">
                <a href="${setupUrl}" style="display: inline-block; background-color: #3b82f6; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                  Set Up Direct Debit Now
                </a>
              </div>

              <div style="background-color: #dbeafe; border-left: 4px solid #3b82f6; padding: 16px; border-radius: 4px; margin: 24px 0;">
                <p style="margin: 0; color: #1e40af; font-size: 14px; line-height: 1.5;">
                  <strong>Why Direct Debit?</strong><br/>
                  Direct Debit ensures uninterrupted service by automatically collecting your monthly subscription and usage charges. It's secure, convenient, and you can cancel anytime.
                </p>
              </div>

              <p style="margin: 0 0 8px 0; color: #334155; font-size: 14px; line-height: 1.6;">
                <strong>What happens next:</strong>
              </p>
              <ol style="margin: 0 0 20px 0; padding-left: 20px; color: #475569; font-size: 14px; line-height: 1.6;">
                <li>Click the button above to set up Direct Debit</li>
                <li>You'll be redirected to GoCardless (our secure payment provider)</li>
                <li>Authorize your bank account details</li>
                <li>Your service will be activated automatically</li>
              </ol>

              <p style="margin: 0; color: #334155; font-size: 14px; line-height: 1.6;">
                If you have any questions or need assistance, please don't hesitate to contact our support team.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; background-color: #f8fafc; border-top: 2px solid #e2e8f0; border-radius: 0 0 8px 8px;">
              <p style="margin: 0 0 10px 0; color: #64748b; font-size: 13px; line-height: 1.5;">
                Questions? Contact us at hello@receptionmate.co.uk
              </p>
              <p style="margin: 0; color: #94a3b8; font-size: 12px;">
                ReceptionMate © ${new Date().getFullYear()} | Automated Billing System
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
}

/**
 * Generate plain text email for Direct Debit request
 */
function generateDirectDebitRequestText(
  userName: string,
  garageNames: string[],
  setupUrl: string
): string {
  let text = `SET UP YOUR DIRECT DEBIT - RECEPTIONMATE\n\n`;
  text += `Hi ${userName},\n\n`;
  text += `To complete your ReceptionMate setup and start using your AI phone answering service, we need you to set up Direct Debit for automatic billing.\n\n`;

  if (garageNames.length > 0) {
    text += `Your branch${garageNames.length > 1 ? 'es' : ''}:\n`;
    garageNames.forEach(name => {
      text += `  • ${name}\n`;
    });
    text += `\n`;
  }

  text += `WHY DIRECT DEBIT?\n`;
  text += `Direct Debit ensures uninterrupted service by automatically collecting your monthly subscription and usage charges. It's secure, convenient, and you can cancel anytime.\n\n`;

  text += `WHAT HAPPENS NEXT:\n`;
  text += `1. Click the link below to set up Direct Debit\n`;
  text += `2. You'll be redirected to GoCardless (our secure payment provider)\n`;
  text += `3. Authorize your bank account details\n`;
  text += `4. Your service will be activated automatically\n\n`;

  text += `SET UP DIRECT DEBIT NOW:\n`;
  text += `${setupUrl}\n\n`;

  text += `If you have any questions or need assistance, please contact our support team at hello@receptionmate.co.uk\n\n`;

  text += `ReceptionMate © ${new Date().getFullYear()}\n`;

  return text;
}
