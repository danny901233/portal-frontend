/**
 * Onboard Elite Autocare garage (Tyresoft) using test credentials.
 * Run: npx tsx backend/scripts/onboardEliteAutocare.ts
 *
 * Uses test Tyresoft API credentials as a placeholder until real
 * credentials arrive from Dan / Tyresoft.
 */
import { prisma } from '../src/db.js';
import bcrypt from 'bcryptjs';

async function main() {
  // -------------------------------------------------------------------------
  // 1. Create or find the Business entity
  // -------------------------------------------------------------------------
  let business = await prisma.business.findFirst({
    where: { name: 'Elite Autocare' },
  });

  if (!business) {
    business = await prisma.business.create({
      data: {
        name: 'Elite Autocare',
        contactName: 'Charlie Allum',
        contactPhone: '+447734787174',
      },
    });
    console.log('Created business:', business.id);
  } else {
    console.log('Business already exists:', business.id);
  }

  // -------------------------------------------------------------------------
  // 2. Create the Garage
  // -------------------------------------------------------------------------
  let garage = await prisma.garage.findFirst({
    where: { name: 'Elite Autocare', businessId: business.id },
  });

  if (!garage) {
    garage = await prisma.garage.create({
      data: {
        name: 'Elite Autocare',
        businessId: business.id,
        hasMessagingAccess: false,
        subscriptionCostGbp: 0,
        includedMinutes: 0,
        costPerMinuteGbp: 0,
      },
    });
    console.log('Created garage:', garage.id);
  } else {
    console.log('Garage already exists:', garage.id);
  }

  // -------------------------------------------------------------------------
  // 3. Create the AgentConfiguration with test Tyresoft credentials
  //    (replace with real credentials when received from Dan)
  // -------------------------------------------------------------------------
  const existingConfig = await prisma.agentConfiguration.findUnique({
    where: { garageId: garage.id },
  });

  if (!existingConfig) {
    await prisma.agentConfiguration.create({
      data: {
        garageId: garage.id,
        branchName: 'Elite Autocare',
        agentScript: 'tyresoft-agent',
        integrationProvider: 'tyresoft',
        // TEST CREDENTIALS — replace with real values from Dan
        integrationProviderConfig: {
          tyresoft: {
            tsWorkspace: 'test',
            tsUsername: 'tyresoft_3pty_api',
            tsPassword: 'tyresoft_3pty_api',
            tsApiKey: 'UeA4clkuEl3tmiAasP96h7Rh9X4QMtk99DntTPjF',
            tsDepotId: 1,
          },
        },
        allowBookings: true,
        bookingLeadTimeDays: 1,
        weeklyOpeningHours: {
          monday:    { open: '08:00', close: '17:30' },
          tuesday:   { open: '08:00', close: '17:30' },
          wednesday: { open: '08:00', close: '17:30' },
          thursday:  { open: '08:00', close: '17:30' },
          friday:    { open: '08:00', close: '17:30' },
          saturday:  { open: '08:30', close: '13:00' },
          sunday:    null,
        },
        notificationEmails: ['charlie@eliteautocare.co.uk'],
        voice: 'leah',
        tonePreference: 'standard',
        responseSpeed: 'normal',
        interruptionSensitivity: 0.5,
      },
    });
    console.log('Created agent config');
  } else {
    console.log('Agent config already exists — skipping');
  }

  // -------------------------------------------------------------------------
  // 4. Create a portal user for Charlie
  // -------------------------------------------------------------------------
  const existingUser = await prisma.user.findUnique({
    where: { email: 'charlie@eliteautocare.co.uk' },
  });

  if (!existingUser) {
    const passwordHash = await bcrypt.hash('ChangeMe123!', 10);
    await prisma.user.create({
      data: {
        email: 'charlie@eliteautocare.co.uk',
        passwordHash,
        mustChangePassword: true,
        role: 'USER',
        garageAccessIds: [garage.id],
      },
    });
    console.log('Created user: charlie@eliteautocare.co.uk (password: ChangeMe123!)');
  } else {
    console.log('User already exists — updating garageAccessIds');
    if (!existingUser.garageAccessIds.includes(garage.id)) {
      await prisma.user.update({
        where: { id: existingUser.id },
        data: { garageAccessIds: { push: garage.id } },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n✓ Elite Autocare onboarded');
  console.log(`  Garage ID: ${garage.id}`);
  console.log(`  Business ID: ${business.id}`);
  console.log('  Credentials: TEST (update when real creds received from Dan)');
  console.log('\nNext steps:');
  console.log(`  1. Upload their CSV:  POST /api/garages/${garage.id}/tyre-feed/1`);
  console.log('  2. Update real credentials in integrationProviderConfig');
  console.log('  3. Provision Twilio number');
}

main()
  .catch((error) => {
    console.error('Onboarding failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
