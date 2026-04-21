const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('Looking for dan@receptionmate.co.uk...\n');
  
  const user = await prisma.user.findUnique({
    where: { email: 'dan@receptionmate.co.uk' }
  });

  if (user) {
    console.log('✓ User found:');
    console.log(`  Email: ${user.email}`);
    console.log(`  ID: ${user.id}`);
    console.log(`  Role: ${user.role}`);
    console.log(`  Created: ${user.createdAt}`);
    
    if (user.role !== 'RECEPTIONMATE_STAFF') {
      console.log('\n⚠️  User role is NOT RECEPTIONMATE_STAFF!');
      console.log('This is why observability is hidden.');
    } else {
      console.log('\n✓ User has RECEPTIONMATE_STAFF role');
      console.log('Check your browser localStorage:');
      console.log('  - rm_user_role should be "RECEPTIONMATE_STAFF"');
      console.log('  - Try logging out and back in');
    }
  } else {
    console.log('✗ User not found');
    console.log('\nSearching for users with "dan" or "receptionmate"...\n');
    
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: 'dan' } },
          { email: { contains: 'receptionmate' } }
        ]
      },
      select: {
        id: true,
        email: true,
        role: true
      }
    });
    
    console.log(`Found ${users.length} matching users:`);
    users.forEach(u => {
      console.log(`  - ${u.email} (${u.role})`);
    });
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
