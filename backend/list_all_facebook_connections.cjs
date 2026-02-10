const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Listing all Facebook connections:\n');

  const connections = await prisma.socialMediaConnection.findMany({
    where: {
      platform: 'facebook',
    },
    include: {
      garage: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (connections.length === 0) {
    console.log('❌ No Facebook connections found in database');
    return;
  }

  console.log(`Found ${connections.length} Facebook connection(s):\n`);

  connections.forEach((conn, i) => {
    console.log(`${i + 1}. Connection ID: ${conn.id}`);
    console.log(`   Garage: ${conn.garage.name} (${conn.garageId})`);
    console.log(`   Page ID: ${conn.pageId}`);
    console.log(`   Is Active: ${conn.isActive}`);
    console.log(`   Has Access Token: ${!!conn.accessToken}`);
    console.log(`   Created: ${conn.createdAt}`);
    console.log('');
  });

  // Also check the specific garage
  console.log('\nChecking garage d51dfa55-15d0-4d60-ad81-c675579d16f6:');
  const garage = await prisma.garage.findUnique({
    where: { id: 'd51dfa55-15d0-4d60-ad81-c675579d16f6' },
    select: { id: true, name: true, hasMessagingAccess: true },
  });

  if (garage) {
    console.log(`✓ Garage exists: ${garage.name}`);
    console.log(`  Has Messaging Access: ${garage.hasMessagingAccess}`);
  } else {
    console.log('❌ Garage not found');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
