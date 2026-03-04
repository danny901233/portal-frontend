const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('Fetching all garages...\n');

  const garages = await prisma.garage.findMany({
    select: {
      id: true,
      name: true,
      hasMessagingAccess: true,
      twilioNumber: true,
    },
  });

  console.log(`Found ${garages.length} garage(s):\n`);

  garages.forEach((garage, index) => {
    console.log(`${index + 1}. ${garage.name}`);
    console.log(`   ID: ${garage.id}`);
    console.log(`   Twilio: ${garage.twilioNumber || 'N/A'}`);
    console.log(`   Messaging Access: ${garage.hasMessagingAccess}`);
    console.log('');
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
