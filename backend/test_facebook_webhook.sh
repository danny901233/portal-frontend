#!/bin/bash

# Test Facebook webhook verification
echo "Testing Facebook webhook verification..."
curl -X GET "https://portal.receptionmate.co.uk/api/webhooks/meta-facebook?hub.mode=subscribe&hub.verify_token=test_token_123&hub.challenge=test_challenge"
echo ""

# Test Facebook webhook message delivery
echo "Testing Facebook webhook message delivery..."
curl -X POST "https://portal.receptionmate.co.uk/api/webhooks/meta-facebook" \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "id": "test-page-id",
      "messaging": [{
        "sender": {"id": "test-sender-123"},
        "message": {
          "text": "Test message from curl"
        }
      }]
    }]
  }'
echo ""
echo "Done!"
