import cron from 'node-cron';
import { generateWeeklyReports, generateMonthlyReports } from './reportGenerator.js';
import { processMonthlyBilling } from '../services/billing.js';
import { processInvoicePreviewEmails } from '../services/invoicePreview.js';
import { refreshTemplateToken } from '../services/metaTemplateToken.js';
import { syncGocardlessPayments } from '../services/gocardlessSync.js';
import { PrismaClient } from '@prisma/client';
import { sendEmail } from './email.js';

const prisma = new PrismaClient();

export const initializeScheduledReports = (): void => {
  console.log('Initializing scheduled jobs...');

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
};
