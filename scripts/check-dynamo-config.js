const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');

const client = new DynamoDBClient({ region: 'eu-west-2' });

async function checkConfig() {
  const garageId = 'e1a3fa3b-aced-40d1-84e7-e99b30fda058';
  
  try {
    const response = await client.send(new GetItemCommand({
      TableName: 'AgentConfig',
      Key: { garageId: { S: garageId } }
    }));
    
    if (!response.Item) {
      console.log('No DynamoDB config found for this garage');
      return;
    }
    
    console.log('\n=== DYNAMODB CONFIGURATION ===');
    console.log('Updated At:', response.Item.updatedAt?.S || 'N/A');
    
    if (response.Item.configuration?.S) {
      const config = JSON.parse(response.Item.configuration.S);
      console.log('\nConfiguration Keys:', Object.keys(config).sort());
      console.log('\nAgent Type:', config.agentType || 'NOT SET');
      console.log('Branch Name:', config.branchName || 'NOT SET');
      console.log('Integration Provider:', config.integrationProvider || 'NOT SET');
      
      console.log('\nFull Configuration:');
      console.log(JSON.stringify(config, null, 2));
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkConfig();
