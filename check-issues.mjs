// Diagnostic script to check messaging and payment setup issues
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkIssues() {
  console.log('🔍 Checking Portal Issues...\n');

  // 1. Check Messaging Access
  console.log('📱 MESSAGING FEATURE STATUS:');
  console.log('=' .repeat(50));

  const garages = await prisma.garage.findMany({
    select: {
      id: true,
      name: true,
      hasMessagingAccess: true,
      business: {
        select: {
          name: true
        }
      }
    }
  });

  if (garages.length === 0) {
    console.log('❌ No garages found in database');
  } else {
    garages.forEach(garage => {
      const status = garage.hasMessagingAccess ? '✅ ENABLED' : '❌ DISABLED';
      console.log(`\n${status} - ${garage.name}`);
      console.log(`   Business: ${garage.business?.name || 'N/A'}`);
      console.log(`   Garage ID: ${garage.id}`);
      console.log(`   hasMessagingAccess: ${garage.hasMessagingAccess}`);
    });
  }

  // 2. Check GoCardless Payment Setup
  console.log('\n\n💳 GOCARDLESS PAYMENT SETUP STATUS:');
  console.log('=' .repeat(50));

  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      mustSetupPayment: true,
      mustChangePassword: true,
      gocardlessMandateId: true,
      gocardlessCustomerId: true,
      garageAccessIds: true,
      role: true
    }
  });

  if (users.length === 0) {
    console.log('❌ No users found in database');
  } else {
    for (const user of users) {
      console.log(`\n👤 ${user.email} (${user.role})`);
      console.log(`   User ID: ${user.id}`);
      console.log(`   mustChangePassword: ${user.mustChangePassword}`);
      console.log(`   mustSetupPayment: ${user.mustSetupPayment}`);
      console.log(`   Has GoCardless Mandate: ${!!user.gocardlessMandateId}`);
      console.log(`   Mandate ID: ${user.gocardlessMandateId || 'None'}`);
      console.log(`   Customer ID: ${user.gocardlessCustomerId || 'None'}`);

      // Get garage info for this user
      if (user.garageAccessIds.length > 0) {
        const userGarages = await prisma.garage.findMany({
          where: { id: { in: user.garageAccessIds } },
          select: {
            name: true,
            trialEndDate: true,
            requiresBookingActivation: true,
            subscriptionCostGbp: true
          }
        });

        console.log(`   Garages: ${userGarages.map(g => g.name).join(', ')}`);

        userGarages.forEach(g => {
          const inTrial = g.trialEndDate && new Date(g.trialEndDate) > new Date();
          console.log(`      - ${g.name}:`);
          console.log(`        Trial: ${inTrial ? `Active until ${g.trialEndDate}` : 'No trial'}`);
          console.log(`        Requires Booking Activation: ${g.requiresBookingActivation}`);
          console.log(`        Subscription Cost: £${g.subscriptionCostGbp}/month`);
        });
      }
    }
  }

  // 3. Check Environment Variables
  console.log('\n\n⚙️  ENVIRONMENT CONFIGURATION:');
  console.log('=' .repeat(50));
  console.log(`GOCARDLESS_ACCESS_TOKEN: ${process.env.GOCARDLESS_ACCESS_TOKEN ? '✅ Set' : '❌ Not set'}`);
  console.log(`GOCARDLESS_ENVIRONMENT: ${process.env.GOCARDLESS_ENVIRONMENT || '❌ Not set (defaults to sandbox)'}`);
  console.log(`PORTAL_URL: ${process.env.PORTAL_URL || '❌ Not set'}`);

  // 4. Recommendations
  console.log('\n\n💡 RECOMMENDATIONS:');
  console.log('=' .repeat(50));

  const disabledGarages = garages.filter(g => !g.hasMessagingAccess);
  if (disabledGarages.length > 0) {
    console.log('\n📱 To enable messaging for a garage, run:');
    console.log('   node fix-issues.js enable-messaging <garage-id>');
    console.log('\n   Or enable for all garages:');
    console.log('   node fix-issues.js enable-messaging-all');
  }

  const usersNeedingPayment = users.filter(u => u.mustSetupPayment && !u.gocardlessMandateId);
  if (usersNeedingPayment.length > 0) {
    console.log('\n💳 Users need to complete payment setup:');
    usersNeedingPayment.forEach(u => {
      console.log(`   - ${u.email}: Login and complete /setup-payment flow`);
    });
  }

  const usersInTrial = [];
  for (const user of users) {
    if (user.garageAccessIds.length > 0) {
      const userGarages = await prisma.garage.findMany({
        where: { id: { in: user.garageAccessIds } },
        select: { trialEndDate: true }
      });

      const hasActiveTrial = userGarages.some(g =>
        g.trialEndDate && new Date(g.trialEndDate) > new Date()
      );

      if (hasActiveTrial) {
        usersInTrial.push(user.email);
      }
    }
  }

  if (usersInTrial.length > 0) {
    console.log('\n⏰ Users currently in trial (payment setup deferred):');
    usersInTrial.forEach(email => console.log(`   - ${email}`));
  }

  console.log('\n');
  await prisma.$disconnect();
}

checkIssues().catch(console.error);
