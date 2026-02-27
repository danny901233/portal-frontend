import { PrismaClient } from '../backend/node_modules/.prisma/client/index.js';
import { sendWelcomeEmail } from '../backend/src/utils/email.js';

const prisma = new PrismaClient();

async function sendTestWelcomeEmail() {
  try {
    const testEmail = process.argv[2] || 'dantyldesley@hotmail.co.uk';
    const searchTerm = process.argv[3];

    if (!searchTerm) {
      console.log('Usage: npx tsx scripts/send-welcome-email.ts <test-email> <garage-name>');
      console.log('Example: npx tsx scripts/send-welcome-email.ts dantyldesley@hotmail.co.uk "VWGS"');
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
      },
      include: {
        business: true
      }
    });

    if (!garage) {
      console.log(`❌ No garage found matching "${searchTerm}"`);
      await prisma.$disconnect();
      return;
    }

    // Find the owner user for this garage
    const owner = await prisma.user.findFirst({
      where: {
        garageAccessIds: {
          has: garage.id
        },
        role: 'owner'
      }
    });

    if (!owner) {
      console.log(`❌ No owner user found for ${garage.name}`);
      await prisma.$disconnect();
      return;
    }

    console.log(`✅ Found garage: ${garage.name}`);
    console.log(`   Business: ${garage.business?.name || 'N/A'}`);
    console.log(`   Owner: ${owner.email}\n`);

    // Send test email first
    console.log(`📧 Sending TEST welcome email to: ${testEmail}`);
    console.log('⏳ Please wait...\n');

    const testResult = await sendWelcomeEmail({
      to: testEmail,
      businessName: garage.business?.name || garage.name,
      branchName: garage.name,
      email: owner.email,
      password: '[TEST - Password will be shown in real email]',
      portalUrl: 'https://portal.receptionmate.co.uk'
    });

    if (testResult) {
      console.log(`✅ Test email sent successfully to ${testEmail}\n`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      console.log('📨 Ready to send REAL welcome email?');
      console.log(`   To: ${owner.email}`);
      console.log(`   Business: ${garage.business?.name || garage.name}`);
      console.log(`   Branch: ${garage.name}\n`);
      console.log('⚠️  WARNING: This will send the actual welcome email with login credentials!');
      console.log('   Press Ctrl+C to cancel, or wait 5 seconds to proceed...\n');
      
      await new Promise(resolve => setTimeout(resolve, 5000));

      console.log('📧 Sending REAL welcome email...\n');

      const realResult = await sendWelcomeEmail({
        to: owner.email,
        businessName: garage.business?.name || garage.name,
        branchName: garage.name,
        email: owner.email,
        password: '[Existing Account - Password Reset Required]',
        portalUrl: 'https://portal.receptionmate.co.uk'
      });

      if (realResult) {
        console.log(`✅ Welcome email sent successfully to ${owner.email}`);
      } else {
        console.log(`❌ Failed to send real welcome email`);
      }
    } else {
      console.log(`❌ Failed to send test email`);
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

sendTestWelcomeEmail();
