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
        integrationProviderConfig: {
          tyresoft: {
            tsWorkspace: 'eliteautocare',
            tsUsername: 'elite_autocare-3pty',
            tsPassword: '8hh19wv22UI3',
            tsApiKey: 'HPK6iGMcXiagPXSM5Cbbi7r6onsWnInk195ashPz',
            tsDepotId: 6,
            tsChannelId: 31,
            // Engine-size pricing rules (from Charlie Allum)
            pricingRules: {
              OIL: [
                { maxCC: 1000, price: 95.00 },
                { maxCC: 2000, price: 100.00 },
                { maxCC: 2996, price: 110.00 },
                { maxCC: 9999, price: 135.00 },
              ],
              INTS: [
                { maxCC: 1000, price: 110.00 },
                { maxCC: 1300, price: 135.00 },
                { maxCC: 1600, price: 145.00 },
                { maxCC: 2000, price: 160.00 },
                { maxCC: 2996, price: 175.00 },
                { maxCC: 9999, price: 195.00 },
              ],
              FS: [
                { maxCC: 1000, price: 145.00 },
                { maxCC: 1300, price: 155.00 },
                { maxCC: 1600, price: 170.00 },
                { maxCC: 2000, price: 195.00 },
                { maxCC: 2996, price: 225.00 },
                { maxCC: 9999, price: 255.00 },
              ],
            },
            // Service catalogue (overrides global TYRESOFT_SERVICES for this garage)
            tsServices: [
              { id: 'FS',           name: 'Castrol Full Service',              pricingType: 'engine-size' },
              { id: 'INTS',         name: 'Interim Service',                   pricingType: 'engine-size' },
              { id: 'OIL',          name: 'Oil & Filter Change',               pricingType: 'engine-size' },
              { id: 'MOT',          name: 'MOT',                               pricingType: 'fixed', price: 54.00 },
              { id: 'MOT2',         name: 'MOT (with service)',                pricingType: 'fixed', price: 39.99 },
              { id: 'TPMS',         name: 'Supply and Fit TPMS Sensor',        pricingType: 'fixed', price: 65.00 },
              { id: 'TPMSDIAG',     name: 'TPMS Diagnostic',                   pricingType: 'fixed', price: 25.00 },
              { id: 'WAD',          name: 'Wheel Alignment Diagnostics',        pricingType: 'fixed', price: 16.67 },
              { id: 'WHEELREFURB1', name: 'Wheel Refurbishment (up to 18")',   pricingType: 'fixed', price: 66.67 },
              { id: 'WHEELREFURB2', name: 'Wheel Refurbishment (19" and above)', pricingType: 'fixed', price: 83.33 },
              { id: 'WST',          name: 'Wheel Straightening',               pricingType: 'fixed', price: 50.00 },
              { id: 'DIAG',         name: 'Diagnostic Assessment',             pricingType: 'fixed', price: 120.00 },
              { id: 'adas',         name: 'ADAS Diagnostics Check',            pricingType: 'fixed', price: 40.00 },
            ],
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
    // Update pricing rules and service catalogue on existing config
    await prisma.agentConfiguration.update({
      where: { garageId: garage.id },
      data: {
        integrationProviderConfig: {
          tyresoft: {
            tsWorkspace: 'eliteautocare',
            tsUsername: 'elite_autocare-3pty',
            tsPassword: '8hh19wv22UI3',
            tsApiKey: 'HPK6iGMcXiagPXSM5Cbbi7r6onsWnInk195ashPz',
            tsDepotId: 6,
            tsChannelId: 31,
            pricingRules: {
              OIL: [
                { maxCC: 1000, price: 95.00 },
                { maxCC: 2000, price: 100.00 },
                { maxCC: 2996, price: 110.00 },
                { maxCC: 9999, price: 135.00 },
              ],
              INTS: [
                { maxCC: 1000, price: 110.00 },
                { maxCC: 1300, price: 135.00 },
                { maxCC: 1600, price: 145.00 },
                { maxCC: 2000, price: 160.00 },
                { maxCC: 2996, price: 175.00 },
                { maxCC: 9999, price: 195.00 },
              ],
              FS: [
                { maxCC: 1000, price: 145.00 },
                { maxCC: 1300, price: 155.00 },
                { maxCC: 1600, price: 170.00 },
                { maxCC: 2000, price: 195.00 },
                { maxCC: 2996, price: 225.00 },
                { maxCC: 9999, price: 255.00 },
              ],
            },
            tsServices: [
              { id: 'FS',           name: 'Castrol Full Service',              pricingType: 'engine-size' },
              { id: 'INTS',         name: 'Interim Service',                   pricingType: 'engine-size' },
              { id: 'OIL',         name: 'Oil & Filter Change',               pricingType: 'engine-size' },
              { id: 'MOT',          name: 'MOT',                               pricingType: 'fixed', price: 54.00 },
              { id: 'MOT2',         name: 'MOT (with service)',                pricingType: 'fixed', price: 39.99 },
              { id: 'TPMS',         name: 'Supply and Fit TPMS Sensor',        pricingType: 'fixed', price: 65.00 },
              { id: 'TPMSDIAG',     name: 'TPMS Diagnostic',                   pricingType: 'fixed', price: 25.00 },
              { id: 'WAD',          name: 'Wheel Alignment Diagnostics',        pricingType: 'fixed', price: 16.67 },
              { id: 'WHEELREFURB1', name: 'Wheel Refurbishment (up to 18")',   pricingType: 'fixed', price: 66.67 },
              { id: 'WHEELREFURB2', name: 'Wheel Refurbishment (19" and above)', pricingType: 'fixed', price: 83.33 },
              { id: 'WST',          name: 'Wheel Straightening',               pricingType: 'fixed', price: 50.00 },
              { id: 'DIAG',         name: 'Diagnostic Assessment',             pricingType: 'fixed', price: 120.00 },
              { id: 'adas',         name: 'ADAS Diagnostics Check',            pricingType: 'fixed', price: 40.00 },
            ],
          },
        },
      },
    });
    console.log('Agent config updated with pricing rules and service catalogue');
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
  console.log('  Credentials: LIVE (eliteautocare workspace, depot 6, channel 31)');
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
