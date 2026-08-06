import { prisma } from './src/db.js';

const GARAGE_ID = 'e2fb4f90-a3c8-46cd-84c3-0ea89adceae5';

async function main() {
  const updated = await prisma.agentConfiguration.update({
    where: { garageId: GARAGE_ID },
    data: {
      agentScript: 'tyresoft-agent',
      integrationProviderConfig: {
        tsWorkspace: 'test',
        tsUsername:  'tyresoft_3pty_api',
        tsPassword:  'tyresoft_3pty_api',
        tsApiKey:    'UeA4clkuEl3tmiAasP96h7Rh9X4QMtk99DntTPjF',
        tsDepotId:   1,
      },
    },
  });

  console.log('✅ agentScript:', updated.agentScript);
  console.log('✅ integrationProviderConfig set with Tyresoft test credentials');
  console.log('✅ Depot ID: 1 (Test Auto Service Branch 1)');
}

main().catch(console.error).finally(() => prisma.$disconnect());
