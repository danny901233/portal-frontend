import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const prisma = new PrismaClient();

async function recreateUser() {
  try {
    const email = 'louise.helsby@inocentres.co.uk';

    // Try to delete existing user (case-insensitive search)
    const existingUsers = await prisma.user.findMany({
      where: {
        email: {
          equals: email,
          mode: 'insensitive'
        }
      }
    });

    for (const user of existingUsers) {
      console.log('Deleting existing user:', user.email, user.id);
      await prisma.user.delete({
        where: { id: user.id }
      });
      console.log('✓ Deleted');
    }

    if (existingUsers.length === 0) {
      console.log('No existing user found to delete');
    }

    // Create new user with lowercase email and temporary password
    const tempPassword = 'ChangeMe123!'; // User must change on first login
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const newUser = await prisma.user.create({
      data: {
        email: email,
        passwordHash: passwordHash,
        mustChangePassword: true, // Force password change on login
        garageAccessIds: [],
        mustSetupPayment: true
      }
    });

    console.log('\n✓ User created successfully:', JSON.stringify({
      id: newUser.id,
      email: newUser.email,
      createdAt: newUser.createdAt
    }, null, 2));

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

recreateUser();
