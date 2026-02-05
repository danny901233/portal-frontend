import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/db.js';
import { createDefaultWeeklyOpeningHours } from '../src/utils/types.js';
import type { DayOfWeek } from '../src/utils/types.js';

const main = async () => {
  const email = process.env.SEED_USER_EMAIL || 'admin@receptionmate.ai';
  const password = process.env.SEED_USER_PASSWORD || 'ChangeMe123!';
  const businessId = process.env.SEED_BUSINESS_ID || 'd5a97619-c212-4c22-8973-fc946b06ad59';
  const businessName = process.env.SEED_BUSINESS_NAME || 'ReceptionMate Business';
  const garageId = process.env.SEED_GARAGE_ID || '827efd7f-c5df-47b1-b2b0-f9a5bde39efa';
  const garageName = process.env.SEED_GARAGE_NAME || 'ReceptionMate Garage';
  
  // GarageHive integration settings
  const ghInstanceUrl = process.env.SEED_GH_INSTANCE_URL || 'devbc24_mpu';
  const ghCustomerId = process.env.SEED_GH_CUSTOMER_ID || ghInstanceUrl;
  const ghLocationId = process.env.SEED_GH_LOCATION_ID || '399';
  const ghApiKey = process.env.SEED_GH_API_KEY || '';

  const passwordHash = await bcrypt.hash(password, 10);
  const branchRoles = { [garageId]: 'MANAGER' } as const;

  await prisma.business.upsert({
    where: { id: businessId },
    create: {
      id: businessId,
      name: businessName,
    },
    update: {
      name: businessName,
    },
  });

  await prisma.garage.upsert({
    where: { id: garageId },
    create: {
      id: garageId,
      name: garageName,
      businessId,
    },
    update: {
      name: garageName,
      businessId,
    },
  });

  await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash,
      garageAccessIds: [garageId],
      role: 'RECEPTIONMATE_STAFF',
      branchRoles,
    },
    update: {
      passwordHash,
      garageAccessIds: [garageId],
      role: 'ADMIN',
      branchRoles,
    },
  });

  await prisma.agentConfiguration.upsert({
    where: { garageId },
    create: {
      garageId,
      branchName: garageName,
      phoneNumber: '',
      emailAddress: email,
      branchAddress: '',
      websiteUrl: '',
      weeklyOpeningHours: (() => {
        const seededWeeklyOpeningHours = createDefaultWeeklyOpeningHours();
        const standardDays: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
        standardDays.forEach((day) => {
          seededWeeklyOpeningHours[day] = { open: '09:00', close: '17:00', closed: false };
        });
        seededWeeklyOpeningHours.saturday = { open: '09:00', close: '13:00', closed: false };
        seededWeeklyOpeningHours.sunday = { open: null, close: null, closed: true };
        return seededWeeklyOpeningHours;
      })(),
      holidayClosures: '',
      greetingLine: 'Thanks for calling ReceptionMate Garage',
      tonePreference: 'standard',
      responseSpeed: 'normal',
      interruptionSensitivity: 0.5,
      allowFastFitOnly: false,
      integrationProvider: 'garage_hive',
      integrationProviderConfig: {
        instanceUrl: ghInstanceUrl,
        customerId: ghCustomerId,
        locationId: ghLocationId,
        apiKey: ghApiKey,
      },
    },
    update: {
      integrationProvider: 'garage_hive',
      integrationProviderConfig: {
        instanceUrl: ghInstanceUrl,
        customerId: ghCustomerId,
        locationId: ghLocationId,
        apiKey: ghApiKey,
      },
    },
  });

  // eslint-disable-next-line no-console
  console.log(`Seed complete. Business: ${businessId}, Garage: ${garageId}, User: ${email}`);
};

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Seed failed', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
