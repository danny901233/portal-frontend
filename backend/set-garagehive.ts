import { prisma } from './src/db.js';

const updated = await prisma.agentConfiguration.update({
  where: { garageId: 'e2fb4f90-a3c8-46cd-84c3-0ea89adceae5' },
  data: {
    agentScript: 'receptionmate-agent-v3',
    integrationProviderConfig: {
      ghCustomerId: 'devbc24_mpu',
      ghLocationId: '399',
      ghApiKey: '2972fa782cc909fce93daf3c8b6f92df',
    },
  },
});

console.log('✅ agentScript:', updated.agentScript);
console.log('✅ GarageHive credentials set (customer:', 'devbc24_mpu', ', location:', '399', ')');
await prisma.$disconnect();
