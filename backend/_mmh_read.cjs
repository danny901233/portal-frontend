const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const c = await p.agentConfiguration.findUnique({
    where: { garageId: "299f3d43-54a2-4a54-ad13-bbb0a6f04d36" },
    select: { agentScript: true, agentName: true, branchName: true },
  });
  console.log(JSON.stringify(c));
  await p.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
