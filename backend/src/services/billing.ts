import { prisma } from '../db.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const gocardless = require('gocardless-nodejs');
const constants = require('gocardless-nodejs/constants');

// Initialize GoCardless client
const getGocardlessClient = () => {
  const accessToken = process.env.GOCARDLESS_ACCESS_TOKEN;
  const environment = process.env.GOCARDLESS_ENVIRONMENT || 'sandbox';

  if (!accessToken) {
    throw new Error('GOCARDLESS_ACCESS_TOKEN is not configured');
  }

  const gcEnvironment = environment === 'live'
    ? constants.Environments.Live
    : constants.Environments.Sandbox;

  return gocardless(accessToken, gcEnvironment);
};

export interface UsageSummary {
  minutesUsed: number;
  smsCount: number;
}

export interface BillingCalculation {
  subscriptionAmount: number; // in pence
  minutesAmount: number;
  smsAmount: number;
  subtotal: number;
  vatAmount: number;
  total: number;
  breakdown: {
    subscriptionCostGbp: number;
    minutesUsed: number;
    minutesIncluded: number;
    overageMinutes: number;
    costPerMinuteGbp: number;
    smsCount: number;
    costPerSmsGbp: number;
    vatRate: number;
  };
}

/**
 * Calculate usage for a garage in a given period
 */
export async function calculateUsage(
  garageId: string,
  periodStart: Date,
  periodEnd: Date
): Promise<UsageSummary> {
  // Calculate total call minutes
  const calls = await prisma.call.findMany({
    where: {
      garageId,
      createdAt: {
        gte: periodStart,
        lte: periodEnd,
      },
    },
    select: {
      durationSeconds: true,
    },
  });

  const totalSeconds = calls.reduce((sum, call) => sum + call.durationSeconds, 0);
  const minutesUsed = Math.ceil(totalSeconds / 60);

  // Calculate SMS count
  const smsCount = await prisma.smsBookingLink.count({
    where: {
      garageId,
      createdAt: {
        gte: periodStart,
        lte: periodEnd,
      },
    },
  });

  return {
    minutesUsed,
    smsCount,
  };
}

/**
 * Calculate billing amounts for a garage
 */
export async function calculateBilling(
  garageId: string,
  usage: UsageSummary
): Promise<BillingCalculation> {
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: {
      subscriptionCostGbp: true,
      includedMinutes: true,
      costPerMinuteGbp: true,
      vatRate: true,
    },
  });

  if (!garage) {
    throw new Error(`Garage ${garageId} not found`);
  }

  // Calculate overage minutes
  const overageMinutes = Math.max(0, usage.minutesUsed - garage.includedMinutes);

  // Calculate amounts in pence for precision
  const subscriptionAmount = Math.round(garage.subscriptionCostGbp * 100);
  const minutesAmount = Math.round(overageMinutes * garage.costPerMinuteGbp * 100);
  const smsAmount = Math.round(usage.smsCount * 0.99 * 100); // £0.99 per SMS

  const subtotal = subscriptionAmount + minutesAmount + smsAmount;
  const vatAmount = Math.round(subtotal * garage.vatRate);
  const total = subtotal + vatAmount;

  return {
    subscriptionAmount,
    minutesAmount,
    smsAmount,
    subtotal,
    vatAmount,
    total,
    breakdown: {
      subscriptionCostGbp: garage.subscriptionCostGbp,
      minutesUsed: usage.minutesUsed,
      minutesIncluded: garage.includedMinutes,
      overageMinutes,
      costPerMinuteGbp: garage.costPerMinuteGbp,
      smsCount: usage.smsCount,
      costPerSmsGbp: 0.99,
      vatRate: garage.vatRate,
    },
  };
}

/**
 * Generate an invoice for a garage
 */
export async function generateInvoice(
  garageId: string,
  periodStart: Date,
  periodEnd: Date
) {
  // Check if invoice already exists for this period
  const existing = await prisma.invoice.findFirst({
    where: {
      garageId,
      periodStart,
      periodEnd,
    },
  });

  if (existing) {
    throw new Error(`Invoice already exists for this period`);
  }

  // Calculate usage
  const usage = await calculateUsage(garageId, periodStart, periodEnd);

  // Calculate billing
  const billing = await calculateBilling(garageId, usage);

  // Get garage and business info
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: {
      businessId: true,
      subscriptionCostGbp: true,
      includedMinutes: true,
      costPerMinuteGbp: true,
      vatRate: true,
    },
  });

  if (!garage) {
    throw new Error(`Garage ${garageId} not found`);
  }

  // Create invoice
  const invoice = await prisma.invoice.create({
    data: {
      garageId,
      businessId: garage.businessId,
      periodStart,
      periodEnd,
      minutesUsed: usage.minutesUsed,
      minutesIncluded: garage.includedMinutes,
      smsCount: usage.smsCount,
      subscriptionAmount: billing.subscriptionAmount,
      minutesAmount: billing.minutesAmount,
      smsAmount: billing.smsAmount,
      subtotal: billing.subtotal,
      vatAmount: billing.vatAmount,
      total: billing.total,
      subscriptionCostGbp: garage.subscriptionCostGbp,
      costPerMinuteGbp: garage.costPerMinuteGbp,
      vatRate: garage.vatRate,
      status: 'draft',
    },
  });

  return invoice;
}

/**
 * Generate invoices for all garages for a given period
 */
export async function generateInvoicesForPeriod(
  periodStart: Date,
  periodEnd: Date
) {
  const garages = await prisma.garage.findMany({
    where: {
      subscriptionCostGbp: {
        gt: 0, // Only bill garages with subscription cost set
      },
    },
    select: {
      id: true,
      name: true,
    },
  });

  const results = [];

  for (const garage of garages) {
    try {
      const invoice = await generateInvoice(garage.id, periodStart, periodEnd);
      results.push({ garageId: garage.id, garageName: garage.name, success: true, invoiceId: invoice.id });
    } catch (error) {
      results.push({
        garageId: garage.id,
        garageName: garage.name,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}

/**
 * Track confirmed booking and check if subscription should be activated
 * Call this whenever a booking is confirmed
 */
export async function trackConfirmedBooking(garageId: string) {
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: {
      id: true,
      name: true,
      requiresBookingActivation: true,
      bookingsRequiredForActivation: true,
      activationBookingsCount: true,
      subscriptionActivatedAt: true,
      subscriptionCostGbp: true,
    },
  });

  if (!garage) {
    return;
  }

  // Only track if activation is required and not yet activated
  if (!garage.requiresBookingActivation || garage.subscriptionActivatedAt) {
    return;
  }

  const newCount = garage.activationBookingsCount + 1;

  // Check if threshold reached
  if (newCount >= garage.bookingsRequiredForActivation) {
    const now = new Date();

    // Activate subscription!
    await prisma.garage.update({
      where: { id: garageId },
      data: {
        activationBookingsCount: newCount,
        subscriptionActivatedAt: now,
      },
    });

    console.log(`🎉 Garage ${garage.name} reached ${garage.bookingsRequiredForActivation} bookings - subscription activated!`);

    // Set billing cycle start date for the user if not already set
    const user = await prisma.user.findFirst({
      where: {
        garageAccessIds: {
          has: garageId,
        },
      },
      select: {
        id: true,
        email: true,
        billingCycleStartDate: true,
        nextBillingDate: true,
      },
    });

    if (user && !user.billingCycleStartDate) {
      const nextBillingDate = new Date(now);
      nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          billingCycleStartDate: now,
          nextBillingDate: nextBillingDate,
        },
      });

      console.log(`✓ Billing cycle started for ${user.email} - first billing on ${nextBillingDate.toISOString().split('T')[0]}`);
    }
  } else {
    // Just increment count
    await prisma.garage.update({
      where: { id: garageId },
      data: {
        activationBookingsCount: newCount,
      },
    });

    console.log(`Garage ${garage.name} booking count: ${newCount}/${garage.bookingsRequiredForActivation}`);
  }
}

/**
 * Check for garages where trial has ended and start their billing cycle
 */
export async function activateTrialEndedGarages() {
  const now = new Date();

  // Find garages where trial ended but billing hasn't started
  const garages = await prisma.garage.findMany({
    where: {
      trialEndDate: {
        lte: now,
      },
      subscriptionCostGbp: {
        gt: 0,
      },
    },
    select: {
      id: true,
      name: true,
      trialEndDate: true,
    },
  });

  const results = [];

  for (const garage of garages) {
    // Find user with this garage
    const user = await prisma.user.findFirst({
      where: {
        garageAccessIds: {
          has: garage.id,
        },
      },
      select: {
        id: true,
        email: true,
        billingCycleStartDate: true,
        nextBillingDate: true,
      },
    });

    if (user && !user.billingCycleStartDate) {
      // Start billing cycle from when trial ended
      const trialEndDate = garage.trialEndDate!;
      const nextBillingDate = new Date(trialEndDate);
      nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          billingCycleStartDate: trialEndDate,
          nextBillingDate: nextBillingDate,
        },
      });

      results.push({
        garageId: garage.id,
        garageName: garage.name,
        userId: user.id,
        userEmail: user.email,
        trialEndDate: trialEndDate,
        firstBillingDate: nextBillingDate,
      });

      console.log(`✓ Trial ended for ${garage.name} - billing cycle started, first billing on ${nextBillingDate.toISOString().split('T')[0]}`);
    }
  }

  return results;
}

/**
 * Find users who are due for billing (nextBillingDate is today or in the past)
 * Anniversary billing - users are billed on the same day each month as signup
 */
export async function findUsersDueForBilling() {
  const now = new Date();

  const users = await prisma.user.findMany({
    where: {
      nextBillingDate: {
        lte: now,
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
      gocardlessMandateId: true,
    },
  });

  return users;
}

/**
 * Generate invoices for a user's billing cycle
 * Anniversary billing: Bills on same day each month for previous period's usage + next period's subscription
 */
export async function generateInvoicesForUser(userId: string) {
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

  // Calculate the billing period (from last billing date to this billing date)
  const periodEnd = user.nextBillingDate;
  const periodStart = new Date(user.billingCycleStartDate);

  const results = [];
  const invoicesToCharge = [];

  // Generate invoice for each garage the user has access to
  for (const garageId of user.garageAccessIds) {
    try {
      // Check if garage has billing configured
      const garage = await prisma.garage.findUnique({
        where: { id: garageId },
        select: {
          id: true,
          name: true,
          businessId: true,
          subscriptionCostGbp: true,
          includedMinutes: true,
          costPerMinuteGbp: true,
          vatRate: true,
          trialEndDate: true,
          requiresBookingActivation: true,
          bookingsRequiredForActivation: true,
          activationBookingsCount: true,
          subscriptionActivatedAt: true,
        },
      });

      if (!garage || garage.subscriptionCostGbp === 0) {
        results.push({
          garageId,
          garageName: garage?.name || 'Unknown',
          success: false,
          error: 'Billing not configured for this garage',
        });
        continue;
      }

      // Check if garage is in trial period
      const now = new Date();
      const inTrial = garage.trialEndDate && garage.trialEndDate > now;

      if (inTrial) {
        // In trial: Don't charge anything, skip this garage
        console.log(`Garage ${garage.name} is in trial until ${garage.trialEndDate}, skipping billing`);
        results.push({
          garageId,
          garageName: garage.name,
          success: true,
          message: 'In trial period - no charge',
        });
        continue;
      }

      // Check if subscription is activated for booking-based activation
      const needsBookingActivation = garage.requiresBookingActivation &&
        !garage.subscriptionActivatedAt &&
        garage.activationBookingsCount < garage.bookingsRequiredForActivation;

      // Calculate usage for previous period
      const usage = await calculateUsage(garageId, periodStart, periodEnd);

      // Calculate subscription charge (for next period, in advance)
      let subscriptionAmount = 0;

      if (needsBookingActivation) {
        // Not yet activated: Don't charge subscription, only usage
        subscriptionAmount = 0;
        console.log(`Garage ${garage.name} needs ${garage.bookingsRequiredForActivation - garage.activationBookingsCount} more bookings, charging usage only`);
      } else {
        // Anniversary billing: Charge full month subscription for next period
        subscriptionAmount = Math.round(garage.subscriptionCostGbp * 100);
      }

      // Calculate overage minutes
      const overageMinutes = Math.max(0, usage.minutesUsed - garage.includedMinutes);
      const minutesAmount = Math.round(overageMinutes * garage.costPerMinuteGbp * 100);
      const smsAmount = Math.round(usage.smsCount * 0.99 * 100);

      const subtotal = subscriptionAmount + minutesAmount + smsAmount;
      const vatAmount = Math.round(subtotal * garage.vatRate);
      const total = subtotal + vatAmount;

      // Create invoice
      const invoice = await prisma.invoice.create({
        data: {
          garageId,
          businessId: garage.businessId,
          periodStart,
          periodEnd,
          minutesUsed: usage.minutesUsed,
          minutesIncluded: garage.includedMinutes,
          smsCount: usage.smsCount,
          subscriptionAmount,
          minutesAmount,
          smsAmount,
          subtotal,
          vatAmount,
          total,
          subscriptionCostGbp: garage.subscriptionCostGbp,
          costPerMinuteGbp: garage.costPerMinuteGbp,
          vatRate: garage.vatRate,
          status: 'draft',
        },
      });

      // Store invoice for later combined charging
      invoicesToCharge.push({
        invoice,
        garage,
        total,
        subscriptionAmount,
        minutesAmount,
        smsAmount,
      });

      results.push({
        garageId,
        garageName: garage.name,
        success: true,
        invoiceId: invoice.id,
        amount: total / 100,
      });
    } catch (error) {
      results.push({
        garageId,
        garageName: 'Unknown',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Create ONE combined GoCardless payment for all invoices
  if (invoicesToCharge.length > 0) {
    try {
      const totalAmount = invoicesToCharge.reduce((sum, item) => sum + item.total, 0);

      // Get user with mandate
      const userWithMandate = await prisma.user.findFirst({
        where: {
          garageAccessIds: {
            hasSome: user.garageAccessIds,
          },
          gocardlessMandateId: {
            not: null,
          },
        },
      });

      if (!userWithMandate || !userWithMandate.gocardlessMandateId) {
        throw new Error('No valid mandate found');
      }

      const client = getGocardlessClient();

      // Create single combined payment
      const payment = await client.payments.create({
        amount: totalAmount,
        currency: 'GBP',
        description: `ReceptionMate - ${invoicesToCharge.length} branch${invoicesToCharge.length > 1 ? 'es' : ''}`,
        metadata: {
          user_id: user.id,
          invoice_count: invoicesToCharge.length.toString(),
          period_end: periodEnd.toISOString(),
        },
        links: {
          mandate: userWithMandate.gocardlessMandateId,
        },
      });

      // Update all invoices with the same payment ID
      for (const item of invoicesToCharge) {
        await prisma.invoice.update({
          where: { id: item.invoice.id },
          data: {
            status: 'pending',
            gocardlessPaymentId: payment.id,
          },
        });
      }

      // Log details
      const breakdown = invoicesToCharge.map(item =>
        `${item.garage.name}: £${(item.total / 100).toFixed(2)}`
      ).join(', ');

      console.log(`✓ Combined payment created for ${user.email}: £${(totalAmount / 100).toFixed(2)} (${invoicesToCharge.length} branches)`);
      console.log(`  Breakdown: ${breakdown}`);
      console.log(`  Payment ID: ${payment.id}`);

      // Update results to show charged
      results.forEach(r => {
        if (r.success && !r.error) {
          r.charged = true;
        }
      });

    } catch (paymentError) {
      console.error(`Failed to create combined payment:`, paymentError);
      results.forEach(r => {
        if (r.success && !r.error) {
          r.charged = false;
          r.error = paymentError instanceof Error ? paymentError.message : 'Payment failed';
        }
      });
    }
  }

  // Update user's next billing date (anniversary billing - same day next month)
  const newNextBillingDate = new Date(user.nextBillingDate);
  newNextBillingDate.setMonth(newNextBillingDate.getMonth() + 1);

  // Update billing dates
  await prisma.user.update({
    where: { id: userId },
    data: {
      billingCycleStartDate: user.nextBillingDate, // Move cycle start forward
      nextBillingDate: newNextBillingDate,
    },
  });

  return {
    userId: user.id,
    userEmail: user.email,
    periodStart,
    periodEnd,
    nextBillingDate: newNextBillingDate,
    results,
  };
}

/**
 * Process monthly billing for all users due for billing
 */
export async function processMonthlyBilling() {
  // First, activate any garages where trial has ended
  const trialActivations = await activateTrialEndedGarages();
  console.log(`Activated ${trialActivations.length} trial-ended garages`);

  // Then find users due for billing
  const usersDue = await findUsersDueForBilling();

  const results = [];

  for (const user of usersDue) {
    try {
      const result = await generateInvoicesForUser(user.id);
      results.push({
        success: true,
        ...result,
      });
    } catch (error) {
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
    trialActivations: trialActivations.length,
    results,
  };
}

/**
 * Create GoCardless payment for an invoice
 */
export async function createPaymentForInvoice(invoiceId: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      garage: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!invoice) {
    throw new Error('Invoice not found');
  }

  if (invoice.status === 'paid') {
    throw new Error('Invoice already paid');
  }

  // Find user with mandate for this garage
  const user = await prisma.user.findFirst({
    where: {
      garageAccessIds: {
        has: invoice.garageId,
      },
      gocardlessMandateId: {
        not: null,
      },
    },
  });

  if (!user || !user.gocardlessMandateId) {
    throw new Error('No valid mandate found for this garage');
  }

  const client = getGocardlessClient();

  // Create payment (amount in pence)
  const payment = await client.payments.create({
    amount: invoice.total,
    currency: 'GBP',
    description: `ReceptionMate Invoice ${invoice.id.slice(0, 8)} - ${invoice.garage.name}`,
    metadata: {
      invoice_id: invoice.id,
      garage_id: invoice.garageId,
      period_start: invoice.periodStart.toISOString(),
      period_end: invoice.periodEnd.toISOString(),
    },
    links: {
      mandate: user.gocardlessMandateId,
    },
  });

  // Update invoice with payment ID
  const updatedInvoice = await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: 'pending',
      gocardlessPaymentId: payment.id,
    },
  });

  return {
    invoice: updatedInvoice,
    payment,
  };
}
