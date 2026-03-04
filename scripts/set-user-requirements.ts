import { PrismaClient } from '../backend/node_modules/.prisma/client/index.js';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from backend/.env
config({ path: resolve(process.cwd(), 'backend', '.env') });

const prisma = new PrismaClient();

async function setUserRequirements() {
  try {
    const searchTerm = process.argv[2];

    if (!searchTerm) {
      console.log('Usage: npx tsx scripts/set-user-requirements.ts <garage-name>');
      console.log('Example: npx tsx scripts/set-user-requirements.ts "VWGS"');
      await prisma.$disconnect();
      return;
    }

    console.log(`🔍 Searching for garage matching: "${searchTerm}"\n`);

    // Find the garage
    const garage = await prisma.garage.findFirst({
      where: {
        name: {
          contains: searchTerm,
          mode: 'insensitive'
        }
      }
    });

    if (!garage) {
      console.log(`❌ No garage found matching "${searchTerm}"`);
      await prisma.$disconnect();
      return;
    }

    // Find the manager user for this garage
    const user = await prisma.user.findFirst({
      where: {
        garageAccessIds: {
          has: garage.id
        },
        role: 'MANAGER'
      }
    });

    if (!user) {
      console.log(`❌ No manager user found for ${garage.name}`);
      await prisma.$disconnect();
      return;
    }

    console.log(`✅ Found garage: ${garage.name}`);
    console.log(`   User: ${user.email}`);
    console.log(`   Current status:`);
    console.log(`   - Must change password: ${user.mustChangePassword}`);
    console.log(`   - Must setup payment: ${user.mustSetupPayment}`);
    console.log(`   - Setup wizard completed: ${user.setupWizardCompleted}\n`);

    // Update user requirements
    console.log('📝 Updating user requirements...\n');

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        mustChangePassword: true,
        mustSetupPayment: true,
        setupWizardCompleted: false,
        setupWizardCompletedAt: null
      }
    });

    // Update garage setup wizard status too
    await prisma.garage.update({
      where: { id: garage.id },
      data: {
        setupWizardCompleted: false,
        setupWizardCompletedAt: null
      }
    });

    console.log(`✅ Successfully updated requirements for ${user.email}:`);
    console.log(`   - Must change password: ✓`);
    console.log(`   - Must setup payment (Direct Debit): ✓`);
    console.log(`   - Must complete setup wizard: ✓`);
    console.log(`\nUser will be prompted to complete all requirements upon next login.`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

setUserRequirements();
