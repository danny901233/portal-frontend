# GoCardless Webhook Setup Guide

## What the Webhook Does

The webhook automatically handles mandate status changes and keeps your database in sync:

- ✅ **User cancels mandate** → `mustSetupPayment` set to `true`
- ✅ **Mandate fails** → Payment setup required again
- ✅ **Mandate expires** → User redirected to setup on next login
- ✅ **Mandate becomes active** → User granted access

## Webhook Endpoint

Your webhook endpoint is:
```
https://api.receptionmate.co.uk/api/webhooks/gocardless
```

## Setup in GoCardless Dashboard

### 1. Login to GoCardless
- Live: https://manage.gocardless.com/
- Sandbox: https://manage-sandbox.gocardless.com/

### 2. Create Webhook
1. Go to **Developers** → **Webhooks**
2. Click **Create webhook**
3. Enter webhook URL: `https://api.receptionmate.co.uk/api/webhooks/gocardless`
4. GoCardless will generate a **webhook secret**
5. Copy the webhook secret

### 3. Add Webhook Secret to Backend

Add to your `backend/.env`:
```bash
GOCARDLESS_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx
```

### 4. Restart Backend
```bash
cd backend
npm run dev
```

### 5. Test the Webhook

GoCardless provides a test button in the dashboard:
1. Go to your webhook
2. Click **Send test webhook**
3. Check backend logs for: `[GoCardless Webhook] Received X event(s)`

## Events Handled

### Mandate Events
- `mandates.created` - Mandate created
- `mandates.customer_approval_granted` - Customer approved
- `mandates.submitted` - Submitted to bank
- `mandates.active` - Mandate active and ready
- `mandates.cancelled` - User or bank cancelled → **Requires payment setup**
- `mandates.failed` - Mandate setup failed → **Requires payment setup**
- `mandates.expired` - Mandate expired → **Requires payment setup**

### Payment Events (Logged)
- `payments.created`
- `payments.submitted`
- `payments.confirmed`
- `payments.failed`
- `payments.cancelled`

## How It Works

### When User Cancels Mandate:

```
┌──────────────────────────┐
│ 1. User cancels mandate  │
│    (via bank/GoCardless) │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│ 2. GoCardless sends      │
│    webhook event         │
│    POST /api/webhooks/   │
│    gocardless            │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│ 3. Backend verifies      │
│    signature & processes │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│ 4. Database updated:     │
│    mustSetupPayment=true │
│    mandateId=null        │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│ 5. Next login:           │
│    User redirected to    │
│    /setup-payment        │
└──────────────────────────┘
```

## Security Features

1. **Signature Verification**: Every webhook is verified using HMAC-SHA256
2. **Timing-Safe Comparison**: Prevents timing attacks
3. **Error Isolation**: One failed event doesn't stop others
4. **Logging**: All events logged for audit trail

## Monitoring

### Check Webhook Logs
```bash
tail -f /tmp/backend.log | grep "GoCardless"
```

### Verify Webhook is Working
```sql
-- Check for users requiring payment setup
SELECT email, "mustSetupPayment", "gocardlessMandateId"
FROM "User"
WHERE "mustSetupPayment" = true;
```

## Testing the Flow

### Test Mandate Cancellation (Sandbox Only)

1. Set up a test mandate in sandbox
2. Login to GoCardless sandbox dashboard
3. Go to **Payments** → **Mandates**
4. Find your test mandate
5. Click **Cancel mandate**
6. Check backend logs - should see:
   ```
   [GoCardless Webhook] Mandate cancelled: MD000xxx
   [GoCardless] User test@example.com mandate cancelled - payment setup required
   ```
7. Check database - user should have `mustSetupPayment = true`

## Troubleshooting

### Webhook Not Receiving Events
- Check webhook URL is correct in GoCardless dashboard
- Verify backend is accessible from internet
- Check firewall allows POST to webhook endpoint

### Signature Verification Failing
- Verify `GOCARDLESS_WEBHOOK_SECRET` matches dashboard
- Check no extra whitespace in .env file
- Restart backend after changing secret

### Events Not Processing
- Check backend logs for errors
- Verify database connection is working
- Look for `[GoCardless Webhook]` log entries

## Webhook Payload Example

```json
{
  "events": [
    {
      "id": "EV123",
      "created_at": "2026-02-05T14:00:00.000Z",
      "resource_type": "mandates",
      "action": "cancelled",
      "links": {
        "mandate": "MD000ABC123"
      }
    }
  ]
}
```

## Production Checklist

- [ ] Webhook created in GoCardless live dashboard
- [ ] Webhook secret added to production .env
- [ ] Backend restarted with new secret
- [ ] Test webhook sent from dashboard
- [ ] Backend logs show webhook received
- [ ] Test mandate cancellation works
- [ ] User redirected to payment setup after cancellation

## Need Help?

The webhook handler code is in:
`backend/src/routes/webhooks/gocardless.ts`

All webhook events are logged with `[GoCardless Webhook]` prefix for easy filtering.
