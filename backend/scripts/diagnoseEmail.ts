import { prisma } from '../src/db.js';

async function diagnose() {
  const garageId = '4f73c11e-53f5-4591-8531-00717d099f17';

  console.log('=== EMAIL NOTIFICATION DIAGNOSTIC ===\n');

  // 1. Check environment variables
  console.log('1. Environment Variables:');
  console.log('   MAILGUN_API_KEY:', process.env.MAILGUN_API_KEY ? '✓ Set' : '✗ Missing');
  console.log('   MAILGUN_DOMAIN:', process.env.MAILGUN_DOMAIN ? '✓ Set' : '✗ Missing');
  console.log('   MAILGUN_FROM:', process.env.MAILGUN_FROM ? '✓ Set' : '✗ Missing');
  console.log('   O365_SMTP_USER:', process.env.O365_SMTP_USER ? '✓ Set' : '✗ Missing');
  console.log('   O365_SMTP_PASS:', process.env.O365_SMTP_PASS ? '✓ Set' : '✗ Missing');
  console.log('   O365_FROM:', process.env.O365_FROM ? '✓ Set' : '✗ Missing');

  const hasMailgun = !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN && process.env.MAILGUN_FROM);
  const hasO365 = !!(process.env.O365_SMTP_USER && process.env.O365_SMTP_PASS);

  console.log('\n   Email Provider Status:');
  if (hasMailgun) {
    console.log('   ✓ Mailgun configured');
  } else {
    console.log('   ✗ Mailgun NOT configured');
  }

  if (hasO365) {
    console.log('   ✓ Office 365 configured');
  } else {
    console.log('   ✗ Office 365 NOT configured');
  }

  if (!hasMailgun && !hasO365) {
    console.log('\n   ⚠️  CRITICAL: No email provider configured!');
    console.log('   Emails CANNOT be sent without Mailgun or O365 credentials.\n');
  }

  // 2. Check database configuration for the specific garage
  console.log('\n2. Garage Configuration:');
  const config = await prisma.agentConfiguration.findUnique({
    where: { garageId },
    include: { garage: true },
  });

  if (!config) {
    console.log('   ✗ No configuration found for garage');
    console.log(`   Garage ID: ${garageId}`);

    // List all garages to help identify the correct one
    console.log('\n   Available Garages:');
    const allGarages = await prisma.garage.findMany({
      include: { agentConfiguration: { select: { branchName: true, notificationEmails: true } } },
    });

    allGarages.forEach((garage) => {
      console.log(`   - ${garage.id}`);
      console.log(`     Name: ${garage.name}`);
      if (garage.agentConfiguration) {
        console.log(`     Branch: ${garage.agentConfiguration.branchName}`);
        console.log(`     Notification Emails: ${JSON.stringify(garage.agentConfiguration.notificationEmails)}`);
      } else {
        console.log('     No AgentConfiguration');
      }
      console.log('');
    });

    await prisma.$disconnect();
    return;
  }

  console.log(`   Garage Name: ${config.garage.name}`);
  console.log(`   Branch Name: ${config.branchName}`);
  console.log(`   Notification Emails: ${JSON.stringify(config.notificationEmails)}`);
  console.log(`   Email Count: ${Array.isArray(config.notificationEmails) ? config.notificationEmails.length : 0}`);

  if (!config.notificationEmails || config.notificationEmails.length === 0) {
    console.log('\n   ⚠️  WARNING: No notification emails configured!');
    console.log('   Emails will be skipped even if providers are configured.\n');
  } else {
    console.log('\n   ✓ Notification emails configured\n');
  }

  // 3. Check recent calls
  console.log('3. Recent Calls for This Garage:');
  const calls = await prisma.call.findMany({
    where: { garageId },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  if (calls.length === 0) {
    console.log('   No calls found for this garage');
  } else {
    console.log(`   Found ${calls.length} recent calls:`);
    calls.forEach((call, i) => {
      console.log(`   ${i + 1}. ${call.createdAt.toISOString()} - ${call.customerName || 'Unknown'} (${call.callType})`);
    });
  }

  // 4. Summary and recommendations
  console.log('\n=== SUMMARY ===\n');

  const issues: string[] = [];
  const fixes: string[] = [];

  if (!hasMailgun && !hasO365) {
    issues.push('No email provider configured');
    fixes.push('Add Mailgun OR Office 365 credentials to .env file');
  }

  if (!config.notificationEmails || config.notificationEmails.length === 0) {
    issues.push('No notification email addresses configured');
    fixes.push('Add notification emails to the garage configuration in the database or admin portal');
  }

  if (issues.length === 0) {
    console.log('✓ All checks passed! Email notifications should be working.');
  } else {
    console.log('✗ Issues Found:');
    issues.forEach((issue, i) => {
      console.log(`   ${i + 1}. ${issue}`);
    });

    console.log('\n📋 Required Fixes:\n');
    fixes.forEach((fix, i) => {
      console.log(`   ${i + 1}. ${fix}`);
    });
  }

  console.log('\n=== NEXT STEPS ===\n');

  if (!hasMailgun && !hasO365) {
    console.log('Step 1: Add email provider credentials to backend/.env\n');
    console.log('For Mailgun, add:');
    console.log('MAILGUN_API_KEY=your_mailgun_api_key');
    console.log('MAILGUN_DOMAIN=your_mailgun_domain');
    console.log('MAILGUN_FROM=noreply@yourdomain.com\n');
    console.log('OR for Office 365, add:');
    console.log('O365_SMTP_USER=your@email.com');
    console.log('O365_SMTP_PASS=your_app_password');
    console.log('O365_FROM=your@email.com\n');
  }

  if (config && (!config.notificationEmails || config.notificationEmails.length === 0)) {
    console.log('Step 2: Add notification emails to the garage configuration\n');
    console.log('Run this SQL command:');
    console.log(`UPDATE "AgentConfiguration"`);
    console.log(`SET "notificationEmails" = ARRAY['your-email@example.com']`);
    console.log(`WHERE "garageId" = '${garageId}';\n`);
    console.log('OR use the admin portal to configure notification emails for this garage.');
  }

  if (hasMailgun || hasO365) {
    if (config && config.notificationEmails && config.notificationEmails.length > 0) {
      console.log('All configuration looks good! If emails still not arriving:');
      console.log('- Check spam/junk folder');
      console.log('- Verify email provider credentials are correct');
      console.log('- Check backend logs: pm2 logs backend --lines 50');
      console.log('- Test sending a call to trigger an email');
    }
  }

  await prisma.$disconnect();
}

diagnose().catch((error) => {
  console.error('Diagnostic failed:', error);
  process.exit(1);
});
