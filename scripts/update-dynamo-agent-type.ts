import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { PrismaClient } from '../backend/node_modules/.prisma/client/index.js';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from combined aws.env
config({ path: resolve(process.cwd(), 'scripts', 'aws.env') });

const prisma = new PrismaClient();

const DYNAMO_TABLE = 'agent-configs';
const AWS_REGION = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || 'eu-west-2';

async function updateDynamoAgentTypes() {
  const dynamoClient = new DynamoDBClient({
    region: AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });

  // Get all configurations from database
  const configs = await prisma.agentConfiguration.findMany({
    select: {
      garageId: true,
      agentType: true,
      branchName: true,
    },
  });

  console.log(`Found ${configs.length} configurations in database`);

  for (const config of configs) {
    const agentType = config.agentType === 'automate' ? 'automate' : 'assist';
    
    console.log(`Updating DynamoDB for garage ${config.garageId} (${config.branchName}): agentType = ${agentType}`);

    try {
      const updateCommand = new UpdateItemCommand({
        TableName: DYNAMO_TABLE,
        Key: {
          garage_id: { S: config.garageId },
        },
        UpdateExpression: 'SET agentType = :agentType',
        ExpressionAttributeValues: {
          ':agentType': { S: agentType },
        },
      });

      await dynamoClient.send(updateCommand);
      console.log(`✓ Updated ${config.garageId}`);
    } catch (error) {
      console.error(`✗ Failed to update ${config.garageId}:`, error);
    }
  }

  await prisma.$disconnect();
  console.log('\nDone!');
}

updateDynamoAgentTypes().catch((error) => {
  console.error('Script failed:', error);
  process.exit(1);
});
