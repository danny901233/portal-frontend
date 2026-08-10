const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const r = await p.agentConfiguration.update({
    where: { garageId: "299f3d43-54a2-4a54-ad13-bbb0a6f04d36" },
    data: { agentScript: "MMH-agent" }, select: { agentScript: true },
  });
  console.log("agentScript ->", r.agentScript);
  await p.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
