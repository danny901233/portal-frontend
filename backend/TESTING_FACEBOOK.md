# Facebook Messaging Testing Guide

## Prerequisites
- Backend server must be running
- You need admin access to a Facebook Page
- Your Meta App must be configured

## Step 1: Start Backend with Logging

```bash
cd backend
npm run dev
# or
node src/server.js
```

Keep this terminal open to watch logs.

## Step 2: Test OAuth Connection

1. Open browser to: https://portal.receptionmate.co.uk/integrations
2. Click "Connect" on Facebook Messenger
3. Log in to Facebook if needed
4. **IMPORTANT**: Make sure you select a Facebook Page you manage
5. Grant all requested permissions

### What to Watch in Logs:

✅ **Success logs:**
```
[OAuth] User info: { id: '...', name: '...', email: '...' }
[OAuth] Permissions: { data: [...] }
[OAuth] Full pages response: { data: [{ id: '...', name: 'Your Page Name' }] }
[OAuth] Page found: 123456789 Name: Your Page Name
[OAuth] Saving connection data: { garageId: '...', platform: 'facebook', hasPageId: true, hasAccessToken: true }
[OAuth] Creating new connection
[OAuth] Connection created with ID: abc-123-def
```

❌ **Failure logs:**
```
[OAuth] Full pages response: { data: [] }
[OAuth] No Facebook page found in response!
```

## Step 3: Verify Connection in Database

After connecting, run:

```bash
node diagnose_facebook_messaging.cjs
```

You should see:
- ✓ Connection found
- ✓ Page ID present
- ✓ Access token present

## Step 4: Test Webhook Verification

This tests if Meta can verify your webhook:

```bash
curl -X GET "https://portal.receptionmate.co.uk/api/webhooks/meta-facebook?hub.mode=subscribe&hub.verify_token=test_token_123&hub.challenge=CHALLENGE_ACCEPTED"
```

✅ **Expected response:** `CHALLENGE_ACCEPTED`
❌ **If 403 error:** Webhook verify token doesn't match

## Step 5: Configure Webhook in Meta Dashboard

1. Go to: https://developers.facebook.com/apps/
2. Select your app (ID: 1600229954436428)
3. Go to **Messenger** → **Settings** → **Webhooks**
4. Add Callback URL:
   - **URL**: `https://portal.receptionmate.co.uk/api/webhooks/meta-facebook`
   - **Verify Token**: `test_token_123`
   - Click **Verify and Save**
5. Subscribe to webhook fields:
   - ✅ messages
   - ✅ messaging_postbacks
   - ✅ message_reads (optional)
6. Subscribe your Facebook Page to the webhook:
   - In the same Webhooks section
   - Find your page and click "Subscribe"

## Step 6: Test Webhook Message Delivery

### Option A: Send Real Message

1. Go to your Facebook Page on facebook.com
2. Send a message to your page (from your personal account or test account)
3. Watch backend logs for:

```
Facebook message sent to <sender-id>
```

### Option B: Test with cURL

```bash
curl -X POST "https://portal.receptionmate.co.uk/api/webhooks/meta-facebook" \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "id": "YOUR_PAGE_ID_HERE",
      "messaging": [{
        "sender": {"id": "test-user-123"},
        "message": {
          "text": "Test message from curl"
        }
      }]
    }]
  }'
```

Replace `YOUR_PAGE_ID_HERE` with your actual Facebook Page ID.

Watch logs for:
```
No garage found for Facebook pageId: YOUR_PAGE_ID_HERE
```
This is expected if the pageId doesn't match what's in the database.

## Step 7: Check Conversation in Portal

1. Go to: https://portal.receptionmate.co.uk/messages
2. You should see the conversation appear
3. Click on it to see messages
4. Try replying

## Troubleshooting

### Issue: "No Facebook page found"
- **Cause**: Your Facebook account doesn't have any pages
- **Fix**: Create a Facebook Page first, or use an account that has admin access to a page

### Issue: Webhook verification fails (403)
- **Cause**: META_WEBHOOK_VERIFY_TOKEN doesn't match
- **Fix**: Check .env file has `META_WEBHOOK_VERIFY_TOKEN=test_token_123`

### Issue: Messages not received
- **Cause 1**: Webhook not subscribed to page
- **Fix**: Go to Meta dashboard and subscribe your page to the webhook

- **Cause 2**: Page ID in database doesn't match
- **Fix**: Run `node diagnose_facebook_messaging.cjs` and check the Page ID

- **Cause 3**: Access token expired
- **Fix**: Disconnect and reconnect Facebook

### Issue: "Cannot send message: 24-hour window expired"
- **Cause**: Facebook only allows businesses to send messages within 24 hours of last customer message
- **Fix**: Customer must send another message first, or use message templates (requires Meta approval)

## Quick Diagnostic

Run this anytime:
```bash
node diagnose_facebook_messaging.cjs
```

This checks:
- ✅ Environment variables
- ✅ Garage configuration
- ✅ Facebook connection details
- ✅ Access token validity
- ✅ Webhook subscriptions
- ✅ Recent conversations
