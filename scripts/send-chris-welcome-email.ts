import { PrismaClient } from '@prisma/client';
import { sendWelcomeEmail } from '../backend/src/utils/email.js';

const prisma = new PrismaClient();

async function main() {
  console.log('Looking up Chris user and garage info...');
  
  const user = await prisma.user.findFirst({
    where: { email: 'chris@vgsperformance.co.uk' }
  });

  if (!user) {
    console.log('User not found with email chris@vgsperformance.co.uk');
    return;
  }

  console.log(`Found user: ${user.email}`);
  
  if (user.garageAccessIds.length === 0) {
    console.log('User has no garage access');
    return;
  }

  const garage = await prisma.garage.findFirst({
    where: { id: user.garageAccessIds[0] }
  });

  if (!garage) {
    console.log('Garage not found');
    return;
  }

  console.log(`Garage: ${garage.name}`);
  console.log('\nSending welcome email...');

  try {
    const success = await sendWelcomeEmail({
      to: 'chris@vgsperformance.co.uk',
      businessName: garage.name,
      branchName: garage.name,
      email: 'chris@vgsperformance.co.uk',
      password: 'Nomoremissedcalls',
      portalUrl: 'https://portal.receptionmate.co.uk'
    });

    if (success) {
      console.log('✓ Welcome email sent successfully to chris@vgsperformance.co.uk');
    } else {
      console.log('✗ Failed to send welcome email');
    }
  } catch (error) {
    console.error('Error sending welcome email:', error);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
