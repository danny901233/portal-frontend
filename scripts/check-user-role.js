const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkUserRole() {
  try {
    const user = await prisma.user.findUnique({
      where: { email: 'dan@receptionmate.co.uk' },
    });

    if (!user) {
      console.log('User not found: dan@receptionmate.co.uk');
      return;
    }

    console.log('\nUser Details:');
    console.log('Email:', user.email);
    console.log('Role:', user.role);
    console.log('User ID:', user.id);
    
    if (user.role !== 'RECEPTIONMATE_STAFF') {
      console.log('\n⚠️  User is NOT a ReceptionMate staff member!');
      console.log('Current role:', user.role);
      console.log('Need to update to: RECEPTIONMATE_STAFF');
    } else {
      console.log('\n✅ User has correct ReceptionMate staff role');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkUserRole();
