// Fix script for messaging and payment setup issues
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function enableMessaging(garageId) {
  const garage = await prisma.garage.update({
    where: { id: garageId },
    data: { hasMessagingAccess: true },
    include: { business: true }
  });

  console.log(`✅ Messaging enabled for ${garage.name} (${garage.business?.name})`);
  console.log(`   Users can now access the Messages page`);
}

async function enableMessagingForAll() {
  const result = await prisma.garage.updateMany({
    data: { hasMessagingAccess: true }
  });

  console.log(`✅ Messaging enabled for ${result.count} garage(s)`);
}

async function forcePaymentSetup(userEmail) {
  const user = await prisma.user.update({
    where: { email: userEmail },
    data: { mustSetupPayment: true },
  });

  console.log(`✅ Payment setup flag enabled for ${user.email}`);
  console.log(`   User will be prompted to complete GoCardless setup on next login`);
}

async function removeTrialPeriod(garageId) {
  const garage = await prisma.garage.update({
    where: { id: garageId },
    data: { trialEndDate: null },
    include: { business: true }
  });

  console.log(`✅ Trial period removed for ${garage.name}`);

  // Update users to require payment setup
  const users = await prisma.user.findMany({
    where: {
      garageAccessIds: { has: garageId },
      gocardlessMandateId: null
    }
  });

  for (const user of users) {
    await prisma.user.update({
      where: { id: user.id },
      data: { mustSetupPayment: true }
    });
    console.log(`   Updated ${user.email} to require payment setup`);
  }
}

async function disableBookingActivation(garageId) {
  const garage = await prisma.garage.update({
    where: { id: garageId },
    data: { requiresBookingActivation: false },
    include: { business: true }
  });

  console.log(`✅ Booking activation disabled for ${garage.name}`);

  // Update users to require payment setup
  const users = await prisma.user.findMany({
    where: {
      garageAccessIds: { has: garageId },
      gocardlessMandateId: null
    }
  });

  for (const user of users) {
    await prisma.user.update({
      where: { id: user.id },
      data: { mustSetupPayment: true }
    });
    console.log(`   Updated ${user.email} to require payment setup`);
  }
}

// Main CLI handler
const command = process.argv[2];
const arg = process.argv[3];

async function main() {
  if (!command) {
    console.log('Usage:');
    console.log('  node fix-issues.js enable-messaging <garage-id>     - Enable messaging for specific garage');
    console.log('  node fix-issues.js enable-messaging-all             - Enable messaging for all garages');
    console.log('  node fix-issues.js force-payment <user-email>       - Force payment setup for user');
    console.log('  node fix-issues.js remove-trial <garage-id>         - Remove trial period and force payment');
    console.log('  node fix-issues.js disable-activation <garage-id>   - Disable booking activation requirement');
    process.exit(1);
  }

  switch (command) {
    case 'enable-messaging':
      if (!arg) {
        console.error('❌ Please provide a garage ID');
        process.exit(1);
      }
      await enableMessaging(arg);
      break;

    case 'enable-messaging-all':
      await enableMessagingForAll();
      break;

    case 'force-payment':
      if (!arg) {
        console.error('❌ Please provide a user email');
        process.exit(1);
      }
      await forcePaymentSetup(arg);
      break;

    case 'remove-trial':
      if (!arg) {
        console.error('❌ Please provide a garage ID');
        process.exit(1);
      }
      await removeTrialPeriod(arg);
      break;

    case 'disable-activation':
      if (!arg) {
        console.error('❌ Please provide a garage ID');
        process.exit(1);
      }
      await disableBookingActivation(arg);
      break;

    default:
      console.error('❌ Unknown command:', command);
      process.exit(1);
  }

  await prisma.$disconnect();
}

main().catch(console.error);
