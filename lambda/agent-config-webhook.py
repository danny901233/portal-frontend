import json
import boto3
import os
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')
table_name = os.environ.get('DYNAMODB_TABLE', 'agent-configs')
table = dynamodb.Table(table_name)

def lambda_handler(event, context):
    """
    Lambda function to receive agent configuration webhooks and store in DynamoDB.
    This function handles the webhook sent from the portal when agent configurations are updated.
    """
    try:
        # Parse the request body
        body = json.loads(event.get('body', '{}'))
        
        garage_id = body.get('garageId')
        configuration = body.get('configuration', {})
        knowledge_base = body.get('knowledgeBase', [])
        knowledge_version = body.get('knowledgeVersion')
        twilio_number = body.get('twilioNumber')
        
        if not garage_id:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Missing garageId'})
            }
        
        # Prepare the item to store in DynamoDB
        item = {
            'garage_id': garage_id,
            'configuration': json.loads(json.dumps(configuration), parse_float=Decimal),
            'knowledge_base': json.loads(json.dumps(knowledge_base), parse_float=Decimal),
        }
        
        if knowledge_version:
            item['knowledge_version'] = knowledge_version
        
        if twilio_number:
            item['twilio_number'] = twilio_number
        
        # Store in DynamoDB
        table.put_item(Item=item)
        
        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'Configuration stored successfully'})
        }
        
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
