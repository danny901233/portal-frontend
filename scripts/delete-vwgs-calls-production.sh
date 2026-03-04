#!/bin/bash

# Delete all calls for VWGS garage in production
# Run this on the production EC2 server

cd /home/ec2-user/portal-frontend/backend

# Create the delete script in the backend directory
cat > delete-vwgs-calls-temp.mjs << 'EOF'
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function deleteVWGSCalls() {
  try {
    // Find garage by searching for VWGS or chris@vwgs.uk
    console.log('🔍 Searching for VWGS garage...\n');
    
    // Try to find user first
    const user = await prisma.user.findFirst({
      where: {
        email: {
          contains: 'vwgs',
          mode: 'insensitive'
        }
      }
    });

    let garageId;
    let garageName;
    
    if (user && user.garageId) {
      garageId = user.garageId;
      console.log(`✅ Found user: ${user.email}`);
      console.log(`   Garage ID: ${garageId}`);
    } else {
      // Search garages directly
      const garage = await prisma.garage.findFirst({
        where: {
          OR: [
            { name: { contains: 'VWGS', mode: 'insensitive' } },
            { name: { contains: 'Volkswagen', mode: 'insensitive' } },
            { name: { contains: 'VW', mode: 'insensitive' } }
          ]
        }
      });
      
      if (garage) {
        garageId = garage.id;
        garageName = garage.name;
        console.log(`✅ Found garage: ${garage.name}`);
      }
    }

    if (!garageId) {
      console.log('❌ VWGS garage not found');
      await prisma.$disconnect();
      return;
    }

    // Get call count
    const callCount = await prisma.call.count({
      where: { garageId: garageId }
    });

    // Get garage name if we don't have it
    if (!garageName) {
      const garage = await prisma.garage.findUnique({
        where: { id: garageId }
      });
      garageName = garage ? garage.name : 'Unknown';
    }

    console.log(`   Garage: ${garageName}`);
    console.log(`   Calls to delete: ${callCount}\n`);

    if (callCount === 0) {
      console.log('✅ No calls to delete');
      await prisma.$disconnect();
      return;
    }

    console.log('🗑️  Deleting calls...\n');

    const result = await prisma.call.deleteMany({
      where: { garageId: garageId }
    });

    console.log(`✅ Successfully deleted ${result.count} calls for ${garageName}`);
    await prisma.$disconnect();
  } catch (error) {
    console.error('❌ Error:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

deleteVWGSCalls();
EOF

# Run the script with Node.js from the backend directory
node delete-vwgs-calls-temp.mjs

# Clean up
rm delete-vwgs-calls-temp.mjs
