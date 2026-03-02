import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function deleteEACTelfordCalls() {
  try {
    // First, find the garage by name
    const garage = await prisma.garage.findFirst({
      where: {
        OR: [
          { name: { contains: 'EAC', mode: 'insensitive' } },
          { name: { contains: 'Telford', mode: 'insensitive' } }
        ]
      },
      include: {
        agentConfiguration: true
      }
    });

    if (!garage) {
      console.log('❌ EAC Telford garage not found');
      return;
    }

    const displayName = garage.agentConfiguration?.branchName || garage.name;
    console.log(`✅ Found garage: ${displayName} (${garage.id})`);

    // Count calls before deletion
    const callCount = await prisma.call.count({
      where: { garageId: garage.id }
    });

    console.log(`📊 Found ${callCount} calls for ${displayName}`);

    if (callCount === 0) {
      console.log('✅ No calls to delete');
      await prisma.$disconnect();
      return;
    }

    // Ask for confirmation
    console.log(`\n⚠️  About to delete ${callCount} calls for ${displayName}`);
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to proceed...\n');
    
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Delete all calls for this garage
    const result = await prisma.call.deleteMany({
      where: { garageId: garage.id }
    });

    console.log(`✅ Successfully deleted ${result.count} calls for ${displayName}`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

deleteEACTelfordCalls();
