import { PrismaClient } from '../backend/node_modules/.prisma/client/index.js';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from backend/.env
config({ path: resolve(process.cwd(), 'backend', '.env') });

const prisma = new PrismaClient();

async function checkAgentConfig() {
  try {
    const searchTerm = process.argv[2] || 'VWGS';

    console.log(`🔍 Checking agent configuration for: "${searchTerm}"\n`);

    // Find the garage
    const garage = await prisma.garage.findFirst({
      where: {
        name: {
          contains: searchTerm,
          mode: 'insensitive'
        }
      },
      include: {
        agentConfiguration: true
      }
    });

    if (!garage) {
      console.log(`❌ No garage found matching "${searchTerm}"`);
      await prisma.$disconnect();
      return;
    }

    console.log(`✅ Found garage: ${garage.name}`);
    console.log(`   Garage ID: ${garage.id}\n`);

    if (!garage.agentConfiguration) {
      console.log('❌ No agent configuration found for this garage!');
      await prisma.$disconnect();
      return;
    }

    const config = garage.agentConfiguration;
    
    console.log('📋 Agent Configuration:');
    console.log(`   Branch Name: ${config.branchName}`);
    console.log(`   Agent Type: ${config.agentType}`);
    console.log(`   Agent Script: ${config.agentScript}`);
    console.log(`   Voice: ${config.voice}`);
    console.log(`   Phone Number: ${config.phoneNumber || 'Not set'}`);
    console.log(`   SMS Booking Links: ${config.enableSmsBookingLinks}`);
    console.log(`   Integration Provider: ${config.integrationProvider}`);
    console.log(`\n   Created: ${config.createdAt.toLocaleString()}`);
    console.log(`   Updated: ${config.updatedAt.toLocaleString()}\n`);

    // Check if agent type matches script
    if (config.agentScript === 'receptionmate-agent' && config.agentType === 'automate') {
      console.log('✅ Configuration looks correct: receptionmate-agent with automate mode');
    } else if (config.agentScript === 'receptionmate-agent' && config.agentType === 'assist') {
      console.log('✅ Configuration looks correct: receptionmate-agent with assist mode');
    } else {
      console.log('⚠️  WARNING: Unusual configuration combination:');
      console.log(`   Script: ${config.agentScript}`);
      console.log(`   Type: ${config.agentType}`);
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkAgentConfig();
