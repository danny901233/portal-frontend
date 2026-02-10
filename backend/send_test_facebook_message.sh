#!/bin/bash

echo "📨 Sending test Facebook webhook message..."
echo ""

curl -X POST "https://portal.receptionmate.co.uk/api/webhooks/meta-facebook" \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "id": "224576834077659",
      "messaging": [{
        "sender": {"id": "test-user-12345"},
        "message": {
          "mid": "test-message-id",
          "text": "Hello! This is a test message from the webhook."
        },
        "timestamp": '$(date +%s)000'
      }]
    }]
  }'

echo ""
echo ""
echo "✅ Test webhook sent!"
echo ""
echo "Check your backend logs for:"
echo "  - 'Facebook message sent to test-user-12345'"
echo ""
echo "Check the portal for new conversation:"
echo "  https://portal.receptionmate.co.uk/messages"
echo ""
