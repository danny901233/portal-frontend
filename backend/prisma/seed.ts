import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/db.js';
import { createDefaultWeeklyOpeningHours } from '../src/utils/types.js';
import type { DayOfWeek } from '../src/utils/types.js';

const main = async () => {
  const email = process.env.SEED_USER_EMAIL || 'admin@receptionmate.ai';
  const password = process.env.SEED_USER_PASSWORD || 'ChangeMe123!';
  const garageId = process.env.SEED_GARAGE_ID || 'd5a97619-c212-4c22-8973-fc946b06ad59';
  const garageName = process.env.SEED_GARAGE_NAME || 'ReceptionMate Garage';

  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.garage.upsert({
    where: { id: garageId },
    create: {
      id: garageId,
      name: garageName,
    },
    update: {
      name: garageName,
    },
  });

  await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash,
      garageAccessIds: [garageId],
    },
    update: {
      passwordHash,
      garageAccessIds: [garageId],
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
      callSummaryEmail: email,
    },
    update: {},
  });

  // eslint-disable-next-line no-console
  console.log(`Seed complete. User: ${email}, Garage: ${garageId}`);
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
