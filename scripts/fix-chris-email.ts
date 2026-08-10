import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Fixing Chris email address...');
  
  const user = await prisma.user.findFirst({
    where: { email: 'chris@vwsperformance.co.uk' }
  });

  if (!user) {
    console.log('User not found with email chris@vwsperformance.co.uk');
    return;
  }

  console.log(`Found user: ${user.email}`);
  console.log('Updating to chris@vgsperformance.co.uk...');

  await prisma.user.update({
    where: { id: user.id },
    data: {
      email: 'chris@vgsperformance.co.uk'
    }
  });

  console.log('✓ Email updated successfully to chris@vgsperformance.co.uk');
  console.log('\nPassword reset link is still valid:');
  console.log('https://portal.receptionmate.co.uk/reset-password?token=' + user.resetToken);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
