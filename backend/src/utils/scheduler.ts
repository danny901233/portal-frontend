import cron from 'node-cron';
import { generateWeeklyReports, generateMonthlyReports } from './reportGenerator.js';
import { processMonthlyBilling } from '../services/billing.js';
import { processInvoicePreviewEmails } from '../services/invoicePreview.js';
import { refreshTemplateToken } from '../services/metaTemplateToken.js';
import { syncGocardlessPayments } from '../services/gocardlessSync.js';
import { syncNegativeFeedbackToExcel } from '../services/feedbackExcelSync.js';
import { sendInoInvoice } from '../services/inoInvoice.js';
import { runDailyGarageHiveReminders } from '../services/garageHiveReminders.js';
import { processQueuedCampaigns } from '../services/outboundSend.js';
import { sendQuarterlyCommission } from '../services/tyresoftCommission.js';
import { PrismaClient } from '@prisma/client';
import { sendEmail } from './email.js';
import { runDailyReport } from '../services/opsDailyReport.js';
import { resetRecurringTasks, archiveDueGarages } from '../services/opsTaskReset.js';
import { runBillingWatchdog } from '../services/billingWatchdog.js';
import { retryFailedPayments } from '../services/paymentRetry.js';
import { chaseOverdueInvoices } from '../services/invoiceChase.js';

const prisma = new PrismaClient();

export const initializeScheduledReports = (): void => {
  console.log('Initializing scheduled jobs...');

  // Ops board end-of-day report: 21:00 UK, late enough that the day's work is in, early enough
  // that it lands before the daily reset the next morning.
  cron.schedule('0 21 * * *', async () => {
    console.log('Running ops board daily report...');
    try {
      await runDailyReport();
    } catch (error) {
      console.error('Ops board daily report failed:', error);
    }
  }, { timezone: 'Europe/London' });

  // Ops board resets. Each runs just after midnight so the period is fully over — and, for daily,
  // after the 21:00 report has already captured the day. Assignees are preserved.
  cron.schedule('5 0 * * *', async () => {
    try { await resetRecurringTasks('daily'); }
    catch (error) { console.error('Ops board daily reset failed:', error); }
  }, { timezone: 'Europe/London' });

  // Leavers whose notice has expired: switch the service off first thing, so nobody has to
  // remember to do it on the day.
  cron.schedule('20 0 * * *', async () => {
    try { await archiveDueGarages(); }
    catch (error) { console.error('Scheduled garage archive failed:', error); }
  }, { timezone: 'Europe/London' });

  cron.schedule('10 0 * * 1', async () => {   // Monday
    try { await resetRecurringTasks('weekly'); }
    catch (error) { console.error('Ops board weekly reset failed:', error); }
  }, { timezone: 'Europe/London' });

  cron.schedule('15 0 1 * *', async () => {   // 1st of the month
    try { await resetRecurringTasks('monthly'); }
    catch (error) { console.error('Ops board monthly reset failed:', error); }
  }, { timezone: 'Europe/London' });

  // Weekly reports: Every Sunday at 9:00 AM
  cron.schedule('0 9 * * 0', async () => {
    console.log('Running weekly report job...');
    try {
      await generateWeeklyReports();
      console.log('Weekly report job completed successfully');
    } catch (error) {
      console.error('Weekly report job failed:', error);
    }
  }, {
    timezone: 'Europe/London', // UK timezone
  });

  console.log('✓ Weekly reports scheduled: Sundays at 9:00 AM (UK time)');

  // Monthly reports: Last day of month at 9:00 AM
  cron.schedule('0 9 28-31 * *', async () => {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Check if tomorrow is the 1st (meaning today is the last day)
    if (tomorrow.getDate() === 1) {
      console.log('Running monthly report job...');
      try {
        await generateMonthlyReports();
        console.log('Monthly report job completed successfully');
      } catch (error) {
        console.error('Monthly report job failed:', error);
      }
    }
  }, {
    timezone: 'Europe/London', // UK timezone
  });

  console.log('✓ Monthly reports scheduled: Last day of month at 9:00 AM (UK time)');

  // Automatic monthly billing: Every day at 9:00 AM
  cron.schedule('0 9 * * *', async () => {
    console.log('Running automatic monthly billing check...');
    try {
      const result = await processMonthlyBilling();
      if (result.processed > 0) {
        console.log(`✓ Automatic billing completed: ${result.successful} successful, ${result.failed} failed`);
      } else {
        console.log('✓ Automatic billing check completed: No users due for billing');
      }
    } catch (error) {
      console.error('❌ Automatic billing check failed:', error);
    }
  }, {
    timezone: 'Europe/London', // UK timezone
  });

  console.log('✓ Automatic monthly billing scheduled: Daily at 9:00 AM (UK time)');

  // Billing watchdog: 09:30, half an hour after billing runs, so it judges the outcome rather
  // than racing it. Checks that every account which should be paying HAS paid this month —
  // the process reporting success is not the same as money arriving.
  cron.schedule('30 9 * * *', async () => {
    try {
      await runBillingWatchdog();
    } catch (error) {
      console.error('❌ Billing watchdog failed:', error);
    }
  }, { timezone: 'Europe/London' });
  console.log('✓ Billing watchdog scheduled: Daily at 9:30 AM (UK time)');

  // Retry bounced Direct Debits: 10:00, after billing and the watchdog. Waits 4 days before the
  // first retry and gives up after 2, so a customer with a genuine problem is left to a human
  // rather than being charged repeatedly.
  cron.schedule('0 10 * * *', async () => {
    try {
      await retryFailedPayments();
    } catch (error) {
      console.error('❌ Payment retry failed:', error);
    }
  }, { timezone: 'Europe/London' });
  console.log('✓ Failed-payment retry scheduled: Daily at 10:00 AM (UK time)');

  // Chase invoice-payers past their 14-day terms: first reminder on the due date, second 14 days
  // later. Direct Debit customers are handled by the failure/retry path instead.
  cron.schedule('30 10 * * *', async () => {
    try {
      await chaseOverdueInvoices();
    } catch (error) {
      console.error('❌ Invoice chase failed:', error);
    }
  }, { timezone: 'Europe/London' });
  console.log('✓ Overdue invoice chase scheduled: Daily at 10:30 AM (UK time)');

  // In'n'out Autocentres invoice: 1st of each month at 9:00 AM. They pay by their own Direct
  // Debit against an emailed invoice (not GoCardless), so we raise + email the combined 4-branch
  // invoice (subscription + previous month's minutes + VAT) to their accounts team.
  cron.schedule('0 9 1 * *', async () => {
    console.log("Running In'n'out monthly invoice job...");
    try {
      const ok = await sendInoInvoice();
      console.log(`✓ In'n'out invoice job completed (sent=${ok})`);
    } catch (error) {
      console.error("❌ In'n'out invoice job failed:", error);
    }
  }, {
    timezone: 'Europe/London', // UK timezone
  });

  console.log("✓ In'n'out invoice scheduled: 1st of month at 9:00 AM (UK time)");

  // Tyresoft commission statement: 09:00 on the 1st of Jan/Apr/Jul/Oct, covering the
  // quarter that just closed. Tyresoft take 7.5% of what we bill (ex VAT) any garage
  // running their integration, so they need the figure to raise their invoice to us.
  cron.schedule('0 9 1 1,4,7,10 *', async () => {
    console.log('Running Tyresoft quarterly commission job...');
    try {
      const sent = await sendQuarterlyCommission();
      console.log(`✓ Tyresoft commission job completed (sent=${sent})`);
    } catch (error) {
      console.error('❌ Tyresoft commission job failed:', error);
    }
  }, {
    timezone: 'Europe/London', // UK timezone
  });

  console.log('✓ Tyresoft commission scheduled: 1 Jan/Apr/Jul/Oct at 9:00 AM (UK time)');

  // Garage Hive service/MOT reminders: every day at 9:00 AM. For each garage with
  // an enabled Garage Hive connection, pull vehicles due in N days and send the
  // reminder campaign. Delivery/read/reply tracking then flows via the WhatsApp
  // webhook. Runs once daily so each vehicle is caught as it crosses the N-day mark.
  cron.schedule('0 9 * * *', async () => {
    console.log('Running daily Garage Hive reminder job...');
    try {
      const results = await runDailyGarageHiveReminders();
      const totalSent = results.reduce((n, r) => n + (r.sent ?? 0), 0);
      console.log(`✓ Garage Hive reminders completed: ${results.length} garage(s), ${totalSent} message(s) sent`);
    } catch (error) {
      console.error('❌ Garage Hive reminder job failed:', error);
    }
  }, {
    timezone: 'Europe/London', // UK timezone
  });

  console.log('✓ Garage Hive reminders scheduled: Daily at 9:00 AM (UK time)');

  // Invoice preview emails: Every day at 10:00 AM (10 days before billing)
  cron.schedule('0 10 * * *', async () => {
    console.log('Running invoice preview email check...');
    try {
      const result = await processInvoicePreviewEmails();
      if (result.processed > 0) {
        console.log(`✓ Invoice previews sent: ${result.successful} successful, ${result.failed} failed`);
      } else {
        console.log('✓ Invoice preview check completed: No users due in 10 days');
      }
    } catch (error) {
      console.error('❌ Invoice preview email check failed:', error);
    }
  }, {
    timezone: 'Europe/London', // UK timezone
  });

  console.log('✓ Invoice preview emails scheduled: Daily at 10:00 AM (UK time)');

  // Meta template token refresh: Every Monday at 3:00 AM
  // Long-lived user tokens expire after 60 days. Weekly refresh keeps it perpetually valid.
  cron.schedule('0 3 * * 1', async () => {
    console.log('[META-TOKEN] Running weekly token refresh...');
    try {
      await refreshTemplateToken();
      console.log('[META-TOKEN] ✓ Token refreshed successfully');
    } catch (error) {
      console.error('[META-TOKEN] ❌ Token refresh failed:', error);
    }
  }, {
    timezone: 'Europe/London',
  });

  console.log('✓ Meta template token refresh scheduled: Mondays at 3:00 AM (UK time)');

  // Feature announcement email: March 7, 2026 at 8:00 AM (one-time job)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDateStr = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD format
  
  // Schedule for March 7, 2026 at 8:00 AM
  if (tomorrowDateStr === '2026-03-07') {
    cron.schedule('0 8 7 3 *', async () => {
      console.log('Running feature announcement email job...');
      try {
        // Import dynamically to avoid circular dependencies
        const { sendFeatureAnnouncementToAll } = await import('../routes/featureAnnouncement.js');
        const result = await sendFeatureAnnouncementToAll();
        if (result.success) {
          console.log(`✓ Feature announcement sent to ${result.count} users`);
        } else {
          console.error('❌ Feature announcement failed to send');
        }
      } catch (error) {
        console.error('❌ Feature announcement job failed:', error);
      }
    }, {
      timezone: 'Europe/London', // UK timezone
    });
    
    console.log('✓ Feature announcement scheduled: March 7, 2026 at 8:00 AM (UK time)');
  }

  // Daily GoCardless payment sync: Every day at 8:00 AM
  cron.schedule('0 8 * * *', async () => {
    console.log('[GC Sync] Running daily GoCardless payment sync...');
    try {
      await syncGocardlessPayments();
    } catch (error) {
      console.error('[GC Sync] Daily sync failed:', error);
    }
  }, {
    timezone: 'Europe/London',
  });

  console.log('✓ GoCardless payment sync scheduled: Daily at 8:00 AM (UK time)');

  // Negative feedback → OneDrive Excel sync: Every 2 hours
  cron.schedule('0 */2 * * *', async () => {
    console.log('[FEEDBACK-SYNC] Running negative feedback Excel sync...');
    try {
      const result = await syncNegativeFeedbackToExcel();
      if (result.appended > 0) {
        console.log(`[FEEDBACK-SYNC] ✓ Appended ${result.appended} rows, ${result.skipped} already synced`);
      } else {
        console.log('[FEEDBACK-SYNC] ✓ No new rows to sync');
      }
    } catch (error) {
      console.error('[FEEDBACK-SYNC] ❌ Sync failed:', error);
    }
  }, {
    timezone: 'Europe/London',
  });

  console.log('✓ Negative feedback Excel sync scheduled: Every 2 hours (UK time)');

  // Outbound campaign queue processor: Every 30 minutes
  // Picks up campaigns with status='queued' whose resumeAt has passed and sends the next batch
  cron.schedule('*/30 * * * *', async () => {
    try {
      const result = await processQueuedCampaigns();
      if (result.processed > 0) {
        console.log(`[OUTBOUND-CRON] Processed ${result.processed} queued campaign(s)`);
      }
    } catch (error) {
      console.error('[OUTBOUND-CRON] Queue processor failed:', error);
    }
  }, {
    timezone: 'Europe/London',
  });

  console.log('✓ Outbound campaign queue processor scheduled: Every 30 minutes');
};
