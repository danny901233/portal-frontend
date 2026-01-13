import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});
const SHARED_SECRET = process.env.AGENT_CONFIG_WEBHOOK_SECRET || "";

export const handler = async (event) => {
  try {
    console.log("incoming event", JSON.stringify(event, null, 2));
    const body = event.body ? JSON.parse(event.body) : {};
    console.log("parsed body", JSON.stringify(body, null, 2));

    const { garageId, configuration, knowledgeBase, knowledgeVersion } = body;

    if (!garageId || typeof configuration !== "object") {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid payload" }) };
    }

    if (SHARED_SECRET) {
      const provided =
        event.headers?.["x-agent-config-secret"] || event.headers?.["X-Agent-Config-Secret"];
      if (provided !== SHARED_SECRET) {
        return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
      }
    }

    // Write to DynamoDB - store configuration as a Map so agentType is accessible
    await client.send(
      new PutItemCommand({
        TableName: "AgentConfig",
        Item: {
          garageId: { S: garageId },
          updatedAt: { S: new Date().toISOString() },
          configuration: convertToAttributeValue(configuration),
          knowledgeBase: { L: (knowledgeBase ?? []).map(kb => convertToAttributeValue(kb)) },
          knowledgeVersion: knowledgeVersion ? { S: knowledgeVersion } : { NULL: true },
        },
      }),
    );

    // Forward to backend to write env file
    try {
      const response = await fetch(
        "http://ec2-18-171-230-217.eu-west-2.compute.amazonaws.com:4000/webhooks/agent-config",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-agent-config-secret": SHARED_SECRET,
          },
          body: JSON.stringify(body),
        }
      );
      console.log("Backend forward response:", response.status);
    } catch (err) {
      console.error("Failed to forward to backend", err);
    }

    return { statusCode: 204, body: "" };
  } catch (error) {
    console.error("Agent config webhook failed", error);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to persist config" }) };
  }
};

// Helper function to convert JS objects to DynamoDB AttributeValue format
function convertToAttributeValue(obj) {
  if (obj === null || obj === undefined) {
    return { NULL: true };
  }
  
  if (typeof obj === 'string') {
    return { S: obj };
  }
  
  if (typeof obj === 'number') {
    return { N: obj.toString() };
  }
  
  if (typeof obj === 'boolean') {
    return { BOOL: obj };
  }
  
  if (Array.isArray(obj)) {
    return { L: obj.map(item => convertToAttributeValue(item)) };
  }
  
  if (typeof obj === 'object') {
    const map = {};
    for (const [key, value] of Object.entries(obj)) {
      map[key] = convertToAttributeValue(value);
    }
    return { M: map };
  }
  
  return { S: String(obj) };
}
