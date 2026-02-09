import { prisma } from '../db.js';
import { calculateUsage } from './billing.js';
import { sendEmail } from '../utils/email.js';

/**
 * Find users whose billing date is exactly 10 days away
 */
export async function findUsersForInvoicePreview() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tenDaysFromNow = new Date(today);
  tenDaysFromNow.setDate(tenDaysFromNow.getDate() + 10);
  tenDaysFromNow.setHours(23, 59, 59, 999);

  const users = await prisma.user.findMany({
    where: {
      nextBillingDate: {
        gte: tenDaysFromNow,
        lte: tenDaysFromNow,
      },
      gocardlessMandateId: {
        not: null,
      },
      mustSetupPayment: false,
    },
    select: {
      id: true,
      email: true,
      billingCycleStartDate: true,
      nextBillingDate: true,
      garageAccessIds: true,
    },
  });

  return users;
}

/**
 * Generate and send invoice preview email to a user
 */
export async function sendInvoicePreviewEmail(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      billingCycleStartDate: true,
      nextBillingDate: true,
      garageAccessIds: true,
    },
  });

  if (!user || !user.billingCycleStartDate || !user.nextBillingDate) {
    throw new Error('User not found or billing not configured');
  }

  const periodStart = new Date(user.billingCycleStartDate);
  const periodEnd = user.nextBillingDate;
  const today = new Date();

  // Format dates
  const billingDateFormatted = periodEnd.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const garageDetails = [];
  let totalAmount = 0;

  // Calculate usage and costs for each garage
  for (const garageId of user.garageAccessIds) {
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: {
        id: true,
        name: true,
        subscriptionCostGbp: true,
        includedMinutes: true,
        costPerMinuteGbp: true,
        vatRate: true,
        trialEndDate: true,
        requiresBookingActivation: true,
        subscriptionActivatedAt: true,
        bookingsRequiredForActivation: true,
        activationBookingsCount: true,
      },
    });

    if (!garage || garage.subscriptionCostGbp === 0) {
      continue;
    }

    // Check if in trial or needs activation
    const inTrial = garage.trialEndDate && garage.trialEndDate > today;
    if (inTrial) {
      continue;
    }

    const needsActivation = garage.requiresBookingActivation &&
      !garage.subscriptionActivatedAt &&
      garage.activationBookingsCount < garage.bookingsRequiredForActivation;

    // Calculate usage to date
    const usage = await calculateUsage(garageId, periodStart, today);

    // Calculate costs
    let subscriptionAmount = 0;
    if (!needsActivation) {
      subscriptionAmount = garage.subscriptionCostGbp;
    }

    const overageMinutes = Math.max(0, usage.minutesUsed - garage.includedMinutes);
    const minutesAmount = overageMinutes * garage.costPerMinuteGbp;
    const smsAmount = usage.smsCount * 0.99;

    const subtotal = subscriptionAmount + minutesAmount + smsAmount;
    const vatAmount = subtotal * garage.vatRate;
    const total = subtotal + vatAmount;

    totalAmount += total;

    garageDetails.push({
      name: garage.name,
      subscription: subscriptionAmount,
      minutesUsed: usage.minutesUsed,
      includedMinutes: garage.includedMinutes,
      overageMinutes,
      minutesCost: minutesAmount,
      smsCount: usage.smsCount,
      smsCost: smsAmount,
      subtotal,
      vat: vatAmount,
      total,
      vatRate: garage.vatRate * 100,
    });
  }

  if (garageDetails.length === 0) {
    // No billable garages
    return { success: false, reason: 'No billable garages' };
  }

  // Generate email HTML
  const emailHtml = generateInvoicePreviewHtml(
    user.email,
    billingDateFormatted,
    garageDetails,
    totalAmount
  );

  const emailText = generateInvoicePreviewText(
    billingDateFormatted,
    garageDetails,
    totalAmount
  );

  // Send email
  await sendEmail({
    to: [user.email],
    subject: `Your ReceptionMate Invoice Preview - Payment on ${billingDateFormatted}`,
    html: emailHtml,
    text: emailText,
  });

  console.log(`✓ Invoice preview sent to ${user.email} for billing on ${billingDateFormatted} - Total: £${totalAmount.toFixed(2)}`);

  return { success: true, email: user.email, amount: totalAmount };
}

/**
 * Generate HTML for invoice preview email
 */
function generateInvoicePreviewHtml(
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

/**
 * Generate plain text version of invoice preview
 */
function generateInvoicePreviewText(
  billingDate: string,
  garages: any[],
  totalAmount: number
): string {
  let text = `RECEPTIONMATE INVOICE PREVIEW\n\n`;
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
  text += `Questions? Visit your ReceptionMate portal or contact support.\n`;

  return text;
}

/**
 * Process all users for invoice preview emails
 */
export async function processInvoicePreviewEmails() {
  const users = await findUsersForInvoicePreview();

  if (users.length === 0) {
    return {
      processed: 0,
      successful: 0,
      failed: 0,
      results: [],
    };
  }

  const results = [];

  for (const user of users) {
    try {
      const result = await sendInvoicePreviewEmail(user.id);
      results.push({
        success: true,
        userId: user.id,
        userEmail: user.email,
        ...result,
      });
    } catch (error) {
      console.error(`Failed to send invoice preview to ${user.email}:`, error);
      results.push({
        success: false,
        userId: user.id,
        userEmail: user.email,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return {
    processed: results.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  };
}
