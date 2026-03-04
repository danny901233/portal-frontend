import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Updating Chris user requirements...');
  
  const user = await prisma.user.findFirst({
    where: { email: 'chris@vwsperformance.co.uk' }
  });

  if (!user) {
    console.log('User not found with email chris@vwsperformance.co.uk');
    return;
  }

  console.log(`Found user: ${user.email}`);
  console.log('Current state:');
  console.log(`  - Setup wizard completed: ${user.setupWizardCompleted}`);
  console.log(`  - Must change password: ${user.mustChangePassword}`);
  console.log(`  - Must setup payment: ${user.mustSetupPayment}`);

  // Update user to require all setup steps
  await prisma.user.update({
    where: { id: user.id },
    data: {
      setupWizardCompleted: false,
      mustChangePassword: true,
      mustSetupPayment: true
    }
  });

  console.log('\n✓ User updated successfully');
  console.log('New state:');
  console.log('  - Setup wizard completed: false');
  console.log('  - Must change password: true');
  console.log('  - Must setup payment: true');
  console.log('\nChris will now be required to:');
  console.log('  1. Reset their password using the reset link');
  console.log('  2. Complete the setup wizard');
  console.log('  3. Set up direct debit payment');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
