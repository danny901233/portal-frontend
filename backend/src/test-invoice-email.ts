import { sendEmail } from './utils/email.js';

// Test data
const testGarageDetails = [
  {
    name: 'branch test',
    subscription: 50.00,
    minutesUsed: 150,
    includedMinutes: 100,
    overageMinutes: 50,
    minutesCost: 5.00,
    smsCount: 5,
    smsCost: 4.95,
    subtotal: 59.95,
    vat: 11.99,
    total: 71.94,
    vatRate: 20,
  }
];

const totalAmount = 71.94;
const billingDate = '19 February 2026';

function generateTestInvoiceHtml(
  email: string,
  billingDate: string,
  garages: any[],
  totalAmount: number
): string {
  const garagesHtml = garages.map(g => `
    <tr>
      <td colspan="2" style="padding: 20px 0 10px 0; font-weight: 600; color: #1e293b; font-size: 16px;">
        ${g.name}
      </td>
    </tr>
    ${g.subscription > 0 ? `
    <tr>
      <td style="padding: 8px 0; color: #475569;">Monthly Subscription</td>
      <td style="padding: 8px 0; color: #1e293b; text-align: right;">£${g.subscription.toFixed(2)}</td>
    </tr>
    ` : ''}
    <tr>
      <td style="padding: 8px 0; color: #475569;">
        Call Minutes (${g.minutesUsed} used, ${g.includedMinutes} included)
        ${g.overageMinutes > 0 ? `<br/><span style="color: #ea580c;">+ ${g.overageMinutes} overage minutes</span>` : ''}
      </td>
      <td style="padding: 8px 0; color: #1e293b; text-align: right;">
        ${g.minutesCost > 0 ? `£${g.minutesCost.toFixed(2)}` : 'Included'}
      </td>
    </tr>
    ${g.smsCount > 0 ? `
    <tr>
      <td style="padding: 8px 0; color: #475569;">SMS Messages (${g.smsCount} sent)</td>
      <td style="padding: 8px 0; color: #1e293b; text-align: right;">£${g.smsCost.toFixed(2)}</td>
    </tr>
    ` : ''}
    <tr>
      <td style="padding: 8px 0; color: #475569;">Subtotal</td>
      <td style="padding: 8px 0; color: #1e293b; text-align: right;">£${g.subtotal.toFixed(2)}</td>
    </tr>
    <tr>
      <td style="padding: 8px 0; color: #475569;">VAT (${g.vatRate}%)</td>
      <td style="padding: 8px 0; color: #1e293b; text-align: right;">£${g.vat.toFixed(2)}</td>
    </tr>
    <tr style="border-top: 2px solid #e2e8f0;">
      <td style="padding: 12px 0; color: #0f172a; font-weight: 600;">Total for ${g.name}</td>
      <td style="padding: 12px 0; color: #0f172a; font-weight: 600; text-align: right;">£${g.total.toFixed(2)}</td>
    </tr>
  `).join('');

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
                Invoice Preview
              </h1>
              <p style="margin: 0; color: #64748b; font-size: 14px;">
                Your upcoming payment details
              </p>
            </td>
          </tr>

          <!-- Important Notice -->
          <tr>
            <td style="padding: 30px 40px;">
              <div style="background-color: #dbeafe; border-left: 4px solid #3b82f6; padding: 16px; border-radius: 4px;">
                <p style="margin: 0; color: #1e40af; font-size: 14px; line-height: 1.5;">
                  <strong>Payment Notice:</strong><br/>
                  Your Direct Debit payment of <strong>£${totalAmount.toFixed(2)}</strong> will be collected
                  <strong>on or around ${billingDate}</strong>.<br/>
                  <br/>
                  This is based on your usage to date. Final amount may vary slightly depending on usage in the remaining days.
                </p>
              </div>
            </td>
          </tr>

          <!-- Invoice Details -->
          <tr>
            <td style="padding: 0 40px 40px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                ${garagesHtml}

                <!-- Grand Total -->
                <tr style="border-top: 3px solid #0f172a;">
                  <td style="padding: 20px 0 0 0; color: #0f172a; font-weight: 700; font-size: 18px;">
                    Total Amount to be Charged
                  </td>
                  <td style="padding: 20px 0 0 0; color: #0f172a; font-weight: 700; font-size: 18px; text-align: right;">
                    £${totalAmount.toFixed(2)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; background-color: #f8fafc; border-top: 2px solid #e2e8f0; border-radius: 0 0 8px 8px;">
              <p style="margin: 0 0 10px 0; color: #64748b; font-size: 13px; line-height: 1.5;">
                Questions about your invoice? Contact us or visit your ReceptionMate portal to view detailed usage reports.
              </p>
              <p style="margin: 0; color: #94a3b8; font-size: 12px;">
                ReceptionMate &copy; ${new Date().getFullYear()} | Automated Billing System
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

function generateTestInvoiceText(
  billingDate: string,
  garages: any[],
  totalAmount: number
): string {
  let text = `RECEPTIONMATE INVOICE PREVIEW - TEST EMAIL\n\n`;
  text += `PAYMENT NOTICE:\n`;
  text += `Your Direct Debit payment of £${totalAmount.toFixed(2)} will be collected\n`;
  text += `on or around ${billingDate}.\n\n`;
  text += `This is based on your usage to date. Final amount may vary slightly.\n\n`;
  text += `─────────────────────────────────────────\n\n`;

  garages.forEach(g => {
    text += `${g.name}\n`;
    text += `─────────────────────────────────────────\n`;
    if (g.subscription > 0) {
      text += `Monthly Subscription          £${g.subscription.toFixed(2)}\n`;
    }
    text += `Call Minutes (${g.minutesUsed}/${g.includedMinutes})    `;
    text += g.minutesCost > 0 ? `£${g.minutesCost.toFixed(2)}\n` : `Included\n`;
    if (g.overageMinutes > 0) {
      text += `  (${g.overageMinutes} overage minutes)\n`;
    }
    if (g.smsCount > 0) {
      text += `SMS Messages (${g.smsCount})           £${g.smsCost.toFixed(2)}\n`;
    }
    text += `Subtotal                      £${g.subtotal.toFixed(2)}\n`;
    text += `VAT (${g.vatRate}%)                    £${g.vat.toFixed(2)}\n`;
    text += `TOTAL                         £${g.total.toFixed(2)}\n\n`;
  });

  text += `═════════════════════════════════════════\n`;
  text += `TOTAL AMOUNT TO BE CHARGED: £${totalAmount.toFixed(2)}\n`;
  text += `═════════════════════════════════════════\n\n`;
  text += `This is a TEST email to preview the invoice format.\n\n`;
  text += `Questions? Visit your ReceptionMate portal or contact support.\n`;

  return text;
}

async function sendTestEmail() {
  const email = 'dantyldesley@hotmail.co.uk';

  const emailHtml = generateTestInvoiceHtml(
    email,
    billingDate,
    testGarageDetails,
    totalAmount
  );

  const emailText = generateTestInvoiceText(
    billingDate,
    testGarageDetails,
    totalAmount
  );

  await sendEmail({
    to: [email],
    subject: `[TEST] Your ReceptionMate Invoice Preview - Payment on ${billingDate}`,
    html: emailHtml,
    text: emailText,
  });

  console.log(`✓ Test invoice preview email sent to ${email}`);
}

sendTestEmail().catch(console.error);
