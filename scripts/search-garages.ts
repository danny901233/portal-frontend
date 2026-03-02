import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function searchGarages() {
  try {
    // Search in garage name
    const garagesByName = await prisma.garage.findMany({
      where: {
        name: {
          contains: 'telford',
          mode: 'insensitive'
        }
      },
      include: {
        agentConfiguration: true,
        _count: { select: { calls: true } }
      }
    });

    // Search in agentConfiguration branchName
    const garagesByBranch = await prisma.agentConfiguration.findMany({
      where: {
        branchName: {
          contains: 'telford',
          mode: 'insensitive'
        }
      },
      include: {
        garage: {
          include: {
            _count: { select: { calls: true } }
          }
        }
      }
    });

    console.log('\n🔍 Search results for "telford":\n');
    
    if (garagesByName.length === 0 && garagesByBranch.length === 0) {
      console.log('❌ No garages found matching "telford"');
      
      // Also try EAC
      const eacGarages = await prisma.agentConfiguration.findMany({
        where: {
          OR: [
            { branchName: { contains: 'eac', mode: 'insensitive' } },
            { branchName: { contains: 'euro', mode: 'insensitive' } }
          ]
        },
        include: {
          garage: {
            include: {
              _count: { select: { calls: true } }
            }
          }
        }
      });

      console.log('\n🔍 Search results for "EAC" or "Euro":\n');
      eacGarages.forEach((config) => {
        console.log(`✅ ${config.branchName}`);
        console.log(`   Garage ID: ${config.garageId}`);
        console.log(`   Garage Name: ${config.garage.name}`);
        console.log(`   Calls: ${config.garage._count.calls}\n`);
      });
    } else {
      garagesByName.forEach((garage) => {
        console.log(`✅ ${garage.agentConfiguration?.branchName || garage.name}`);
        console.log(`   Garage ID: ${garage.id}`);
        console.log(`   Calls: ${garage._count.calls}\n`);
      });

      garagesByBranch.forEach((config) => {
        console.log(`✅ ${config.branchName}`);
        console.log(`   Garage ID: ${config.garageId}`);
        console.log(`   Calls: ${config.garage._count.calls}\n`);
      });
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

searchGarages();
