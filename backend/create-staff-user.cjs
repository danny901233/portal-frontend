const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const prisma = new PrismaClient();

async function createStaffUser() {
  try {
    const email = 'hello@receptionmate.co.uk';
    const password = 'Creativestaff2026!';
    
    console.log('🚀 Creating ReceptionMate staff user account...\n');

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      console.log('❌ User already exists with email:', email);
      console.log('User ID:', existingUser.id);
      console.log('\nIf you want to recreate this user, please delete it first.\n');
      return;
    }

    const garages = await prisma.garage.findMany({
      select: { id: true, name: true },
    });

    console.log(`📋 Found ${garages.length} branches in the system`);
    console.log('   Granting access to all branches...\n');

    const garageAccessIds = garages.map(g => g.id);
    const branchRoles = {};
    garages.forEach(g => {
      branchRoles[g.id] = 'MANAGER';
    });

    console.log('🔐 Hashing password...');
    const passwordHash = await bcrypt.hash(password, 10);

    console.log('👤 Creating user account...');
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        role: 'RECEPTIONMATE_STAFF',
        garageAccessIds,
        branchRoles,
        mustChangePassword: false,
        mustSetupPayment: false,
        setupWizardCompleted: true,
        setupWizardCompletedAt: new Date(),
      },
    });

    console.log('✅ User created successfully!');
    console.log('   User ID:', user.id);
    console.log('   Email:', user.email);
    console.log('   Role:', user.role);
    console.log('   Branch Access:', garageAccessIds.length, 'branches');
    console.log('   Branch Roles: MANAGER for all branches\n');

    console.log('📧 Sending welcome email...');
    const portalUrl = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';
    
    try {
      const emailModule = await import('./src/utils/email.js');
      await emailModule.sendWelcomeEmail({
        to: email,
        businessName: 'ReceptionMate',
        branchName: 'Staff Account',
        email,
        password,
        portalUrl,
      });
      console.log('✅ Welcome email sent successfully!\n');
    } catch (emailError) {
      console.error('⚠️  Failed to send welcome email:', emailError.message);
      console.log('   User account was created, but email failed.\n');
    }

    console.log('🎉 Setup complete!\n');
    console.log('Login Details:');
    console.log('  Email:', email);
    console.log('  Password:', password);
    console.log('  Portal:', portalUrl);
    console.log('  Role: ReceptionMate Staff (MANAGER permissions)');
    console.log('  Flags: No password reset, no payment setup, no wizard\n');

  } catch (error) {
    console.error('❌ Error creating staff user:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

createStaffUser();
