import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('Finding user with email chris@vwgs.uk...');
  
  const user = await prisma.user.findFirst({
    where: { email: 'chris@vwgs.uk' }
  });

  if (!user) {
    console.log('User not found with email chris@vwgs.uk');
    return;
  }

  console.log(`Found user: ${user.email}`);
  console.log('User has access to garage IDs:', user.garageAccessIds);
  console.log('\nUpdating email to chris@vwsperformance.co.uk...');

  await prisma.user.update({
    where: { id: user.id },
    data: { email: 'chris@vwsperformance.co.uk' }
  });

  console.log('✓ Email updated successfully');
  
  // Generate password reset token
  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetToken,
      resetTokenExpiry
    }
  });

  console.log('\n✓ Password reset token generated');
  console.log(`Reset link: https://portal.receptionmate.co.uk/reset-password?token=${resetToken}`);
  
  // Fetch garage info if user has access to garages
  console.log('\nLooking up garage information...');
  
  let garageName = null;
  if (user.garageAccessIds.length > 0) {
    const garage = await prisma.garage.findFirst({
      where: { id: user.garageAccessIds[0] }
    });
    if (garage) {
      garageName = garage.name;
      console.log(`Found garage: ${garageName}`);
    }
  }

  // Send welcome email manually since we need to provide reset link
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Email update complete! Please send welcome email manually.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\nTo: chris@vwsperformance.co.uk`);
  if (garageName) {
    console.log(`Business: ${garageName}`);
  }
  console.log(`\nSubject: Welcome to ReceptionMate Portal`);
  console.log(`\nPassword Reset Link (valid 24 hours):`);
  console.log(`https://portal.receptionmate.co.uk/reset-password?token=${resetToken}`);
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
