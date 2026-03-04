import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('Finding user with email chris@vwgs.uk...');
  
  const user = await prisma.user.findFirst({
    where: { email: 'chris@vwgs.uk' },
    include: {
      garages: true
    }
  });

  if (!user) {
    console.log('User not found with email chris@vwgs.uk');
    return;
  }

  console.log(`Found user: ${user.name} (${user.email})`);
  console.log('Garages:', user.garages.map(g => g.name).join(', '));
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
  
  // Now trigger welcome email via backend API
  console.log('\nSending welcome email via backend...');
  
  const garage = user.garages[0];
  if (!garage) {
    console.log('No garage found for user, skipping email');
    return;
  }

  try {
    const response = await fetch('https://portal.receptionmate.co.uk/internal-api/admin/send-welcome', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: user.id,
        email: 'chris@vwsperformance.co.uk',
        name: user.name,
        businessName: garage.businessName || garage.name,
        branchName: garage.name,
        resetToken: resetToken
      })
    });

    if (response.ok) {
      console.log('✓ Welcome email sent successfully');
    } else {
      console.log('Backend endpoint not available, email will need to be sent manually');
      console.log('\nPlease send Chris an email with:');
      console.log(`  Email: chris@vwsperformance.co.uk`);
      console.log(`  Reset link: https://portal.receptionmate.co.uk/reset-password?token=${resetToken}`);
    }
  } catch (error) {
    console.log('Could not connect to backend API');
    console.log('\nPlease send Chris an email with:');
    console.log(`  Email: chris@vwsperformance.co.uk`);
    console.log(`  Name: ${user.name}`);
    console.log(`  Reset link: https://portal.receptionmate.co.uk/reset-password?token=${resetToken}`);
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
