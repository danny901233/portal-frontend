import { prisma } from './src/db.js';
const c = await prisma.agentConfiguration.findUnique({
  where: { garageId: 'e2fb4f90-a3c8-46cd-84c3-0ea89adceae5' },
  select: { agentScript: true, integrationProviderConfig: true },
});
console.log('agentScript:', c?.agentScript);
console.log('hasTypesoftCreds:', !!(c?.integrationProviderConfig && Object.keys(c.integrationProviderConfig as object).length));
await prisma.$disconnect();
