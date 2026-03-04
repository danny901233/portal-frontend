# Meta Platform Integration Setup Guide

This guide explains how to set up WhatsApp Business, Facebook Messenger, and Instagram integrations for ReceptionMate.

## Prerequisites

1. A Meta Business Account
2. Admin access to your Meta App
3. For WhatsApp: A verified WhatsApp Business number
4. For Facebook: A Facebook Page
5. For Instagram: An Instagram Business account linked to your Facebook Page

## Step 1: Create Meta App

1. Go to [Meta for Developers](https://developers.facebook.com/apps/)
2. Click **"Create App"**
3. Choose **"Business"** as the app type
4. Fill in your app details:
   - **App Name**: "ReceptionMate" (or your preferred name)
   - **Contact Email**: Your business email
   - **Business Account**: Select your Meta Business Account

## Step 2: Add Products to Your App

### For WhatsApp Business:
1. In your app dashboard, click **"Add Product"**
2. Find **"WhatsApp"** and click **"Set Up"**
3. Follow the setup wizard to:
   - Select your Business Phone Number
   - Verify your business
   - Configure message templates

### For Facebook Messenger:
1. Click **"Add Product"**
2. Find **"Messenger"** and click **"Set Up"**
3. In the Messenger settings:
   - Add your Facebook Page
   - Generate a Page Access Token

### For Instagram:
1. Click **"Add Product"**
2. Find **"Instagram"** and click **"Set Up"**
3. Connect your Instagram Business account
4. Ensure it's linked to your Facebook Page

## Step 3: Configure OAuth Settings

1. In your Meta App dashboard, go to **Settings** → **Basic**
2. Note down:
   - **App ID** (you'll use this as `META_APP_ID`)
   - **App Secret** (click "Show", you'll use this as `META_APP_SECRET`)

3. Go to **App Settings** → **Advanced** → **Security**
4. Add **OAuth Redirect URI**:
   - Development: `http://localhost:4000/api/oauth/meta/callback`
   - Production: `https://your-domain.com/api/oauth/meta/callback`

## Step 4: Configure Webhooks

### For WhatsApp:
1. Go to **WhatsApp** → **Configuration**
2. In **Webhook** section:
   - **Callback URL**: `https://your-domain.com/api/webhooks/meta-whatsapp`
   - **Verify Token**: Use the value from `META_WEBHOOK_VERIFY_TOKEN`
3. Subscribe to webhook fields:
   - `messages`
   - `message_status`

### For Facebook Messenger:
1. Go to **Messenger** → **Settings** → **Webhooks**
2. Click **"Add Callback URL"**:
   - **Callback URL**: `https://your-domain.com/api/webhooks/meta-facebook`
   - **Verify Token**: Use the value from `META_WEBHOOK_VERIFY_TOKEN`
3. Subscribe to webhook fields:
   - `messages`
   - `messaging_postbacks`
   - `message_reads`

### For Instagram:
1. Go to **Instagram** → **Configuration** → **Webhooks**
2. Click **"Add Callback URL"**:
   - **Callback URL**: `https://your-domain.com/api/webhooks/meta-instagram`
   - **Verify Token**: Use the value from `META_WEBHOOK_VERIFY_TOKEN`
3. Subscribe to webhook fields:
   - `messages`
   - `messaging_postbacks`

## Step 5: Set Environment Variables

Copy `.env.meta.example` to `.env` and add your values:

```bash
# Meta App Credentials
META_APP_ID=123456789012345
META_APP_SECRET=abc123def456ghi789jkl012mno345pq
META_REDIRECT_URI=http://localhost:4000/api/oauth/meta/callback
FRONTEND_URL=http://localhost:3000
META_WEBHOOK_VERIFY_TOKEN=your_random_secure_token_here
```

## Step 6: Request App Review (Production Only)

For production use, you need Meta's approval:

1. In your app dashboard, go to **App Review**
2. Request permissions:
   - **WhatsApp**: `whatsapp_business_management`, `whatsapp_business_messaging`
   - **Facebook**: `pages_messaging`, `pages_manage_metadata`
   - **Instagram**: `instagram_basic`, `instagram_manage_messages`

3. Provide required information:
   - **Use Case**: Customer service and messaging
   - **Platform**: Web application
   - **Demo Video**: Show how you'll use the messaging features
   - **Privacy Policy URL**: Your privacy policy

4. Wait for approval (typically 3-5 business days)

## Step 7: Test the Integration

### Development Mode:
1. Start your backend server
2. Go to **Integrations** page in ReceptionMate
3. Click **"Connect"** for each platform
4. Complete OAuth flow
5. Send a test message

### Production Mode:
1. Ensure your app is approved by Meta
2. Update webhook URLs to production URLs
3. Update `META_REDIRECT_URI` to production callback URL
4. Restart your backend server
5. Test with real customer messages

## Troubleshooting

### "Meta App not configured" error:
- Ensure `META_APP_ID` is set in `.env`
- Restart your backend server after adding environment variables

### OAuth redirect fails:
- Check that `META_REDIRECT_URI` is whitelisted in Meta App settings
- Verify the redirect URI matches exactly (including http/https)

### Webhooks not receiving messages:
- Verify webhook URL is publicly accessible (not localhost)
- Check that webhook verify token matches
- Ensure webhook subscriptions are active in Meta dashboard

### Access token expired:
- Long-lived tokens expire after 60 days
- Implement token refresh logic or have users reconnect

## Security Best Practices

1. **Never commit** `.env` file to version control
2. **Rotate** `META_APP_SECRET` periodically
3. **Use HTTPS** for all production webhook URLs
4. **Validate** webhook signatures from Meta
5. **Store** access tokens encrypted in database
6. **Limit** access to Meta App settings

## Support

For help with Meta integration:
- Meta Developer Docs: https://developers.facebook.com/docs/
- WhatsApp Business API: https://developers.facebook.com/docs/whatsapp/
- Messenger Platform: https://developers.facebook.com/docs/messenger-platform/
- Instagram Messaging: https://developers.facebook.com/docs/messenger-platform/instagram/

For ReceptionMate support:
- Email: support@receptionmate.com
