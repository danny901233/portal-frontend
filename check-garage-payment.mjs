// Check garage subscription and payment info
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const garageId = process.argv[2] || 'd51dfa55-15d0-4d60-ad81-c675579d16f6';

async function checkGarage() {
  const garage = await prisma.garage.findUnique({
    where: { id: garageId }
  });

  if (!garage) {
    console.log('❌ Garage not found');
    return;
  }

  console.log('=== GARAGE INFO ===');
  console.log('Garage ID:', garage.id);
  console.log('Garage Name:', garage.name);
  console.log('');
  console.log('=== SUBSCRIPTION INFO ===');
  console.log('Subscription Cost (GBP):', garage.subscriptionCostGbp);
  console.log('Trial End Date:', garage.trialEndDate);
  console.log('Requires Booking Activation:', garage.requiresBookingActivation);
  console.log('Has Messaging Access:', garage.hasMessagingAccess);
  console.log('');

  // Get users with access to this garage
  const users = await prisma.user.findMany({
    where: {
      garageAccessIds: { has: garageId }
    },
    select: {
      id: true,
      email: true,
      role: true,
      mustSetupPayment: true,
      gocardlessMandateId: true,
      gocardlessCustomerId: true,
      billingCycleStartDate: true,
      nextBillingDate: true
    }
  });

  console.log('=== USERS WITH ACCESS ===');
  if (users.length === 0) {
    console.log('No users found');
  } else {
    users.forEach(user => {
      console.log('');
      console.log('Email:', user.email);
      console.log('Role:', user.role);
      console.log('Must Setup Payment:', user.mustSetupPayment);
      console.log('Has GoCardless Mandate:', !!user.gocardlessMandateId);
      console.log('GoCardless Mandate ID:', user.gocardlessMandateId || 'None');
      console.log('GoCardless Customer ID:', user.gocardlessCustomerId || 'None');
      console.log('Billing Cycle Start:', user.billingCycleStartDate || 'Not set');
      console.log('Next Billing Date:', user.nextBillingDate || 'Not set');
    });
  }

  await prisma.$disconnect();
}

checkGarage().catch(console.error);
