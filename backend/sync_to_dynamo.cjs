// Trigger the same Postgres→DynamoDB sync the portal's PUT endpoint does.
// Uses the compiled buildConfigurationResponse + loadKnowledgeBase from dist/.

const { PrismaClient } = require("@prisma/client");
const { buildConfigurationResponse, loadKnowledgeBase } = require("./dist/routes/config.js");

const WEBHOOK_URL = process.env.AGENT_CONFIG_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.AGENT_CONFIG_WEBHOOK_SECRET;
const GARAGE_IDS = process.argv.slice(2);

if (!WEBHOOK_URL) {
  console.error("AGENT_CONFIG_WEBHOOK_URL not set");
  process.exit(1);
}
if (GARAGE_IDS.length === 0) {
  console.error("Usage: node sync_to_dynamo.cjs <garageId> [garageId2 ...]");
  process.exit(1);
}

(async () => {
  const p = new PrismaClient();
  for (const garageId of GARAGE_IDS) {
    const [configRec, garage] = await Promise.all([
      p.agentConfiguration.findUnique({ where: { garageId } }),
      p.garage.findUnique({ where: { id: garageId }, select: { twilioNumber: true } }),
    ]);
    if (!configRec) {
      console.log(`[${garageId}] no config row — skipping`);
      continue;
    }
    const configuration = buildConfigurationResponse(configRec);
    const knowledgeBase = await loadKnowledgeBase(garageId);
    const knowledgeVersion = knowledgeBase.reduce(
      (latest, d) => (!latest || (d.updatedAt && d.updatedAt > latest) ? d.updatedAt : latest),
      null
    );
    const payload = {
      garageId,
      twilioNumber: garage?.twilioNumber ?? null,
      configuration,
      knowledgeBase,
      knowledgeVersion,
    };
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(WEBHOOK_SECRET ? { "x-agent-config-secret": WEBHOOK_SECRET } : {}),
      },
      body: JSON.stringify(payload),
    });
    const body = await res.text().catch(() => "");
    console.log(`[${garageId}] ${configRec.branchName}: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
