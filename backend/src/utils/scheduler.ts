import cron from 'node-cron';
import { generateWeeklyReports, generateMonthlyReports } from './reportGenerator.js';
import { processMonthlyBilling } from '../services/billing.js';

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
      if (result.summary.processed > 0) {
        console.log(`✓ Automatic billing completed: ${result.summary.successful} successful, ${result.summary.failed} failed`);
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
};
