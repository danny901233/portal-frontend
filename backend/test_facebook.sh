#!/bin/bash

echo "🧪 Facebook Messaging Quick Test"
echo "=================================="
echo ""

# Check if backend is running
echo "1. Checking if backend is running..."
if curl -s http://localhost:4000/health > /dev/null 2>&1; then
    echo "   ✅ Backend is running on port 4000"
else
    echo "   ❌ Backend is NOT running!"
    echo "   Start it with: cd backend && npm run dev"
    exit 1
fi
echo ""

# Check database connection
echo "2. Checking Facebook connection in database..."
node diagnose_facebook_messaging.cjs
echo ""

# Test webhook endpoint
echo "3. Testing webhook endpoint..."
echo "   Testing verification endpoint..."
RESPONSE=$(curl -s "https://portal.receptionmate.co.uk/api/webhooks/meta-facebook?hub.mode=subscribe&hub.verify_token=test_token_123&hub.challenge=TEST123")

if [ "$RESPONSE" == "TEST123" ]; then
    echo "   ✅ Webhook verification works!"
else
    echo "   ❌ Webhook verification failed!"
    echo "   Response: $RESPONSE"
fi
echo ""

echo "=================================="
echo "📋 Next Steps:"
echo "=================================="
echo ""
echo "If NO connection found in database:"
echo "  1. Go to https://portal.receptionmate.co.uk/integrations"
echo "  2. Click 'Connect' on Facebook Messenger"
echo "  3. Watch backend logs for '[OAuth] Connection created'"
echo ""
echo "If connection exists but messages not coming:"
echo "  1. Configure webhook in Meta dashboard"
echo "  2. URL: https://portal.receptionmate.co.uk/api/webhooks/meta-facebook"
echo "  3. Verify Token: test_token_123"
echo "  4. Subscribe to 'messages' events"
echo "  5. Subscribe your Page to the webhook"
echo "  6. Send a test message to your Facebook Page"
echo ""
echo "Full guide: cat TESTING_FACEBOOK.md"
echo ""
