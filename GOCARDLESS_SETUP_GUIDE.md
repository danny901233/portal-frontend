# GoCardless Direct Debit Setup Guide

## Overview
The direct debit mandate system is now ready to go live. Users who have `mustSetupPayment=true` will be redirected to complete payment setup before accessing the portal.

## What I Just Fixed
1. ✅ **Enabled payment check in auth.ts** - Users with `mustSetupPayment=true` are now redirected
2. ✅ **Fixed API URLs** - Frontend payment pages now use correct backend URL
3. ✅ **Created environment variable template** - See `.env.gocardless-example`

## Pre-Launch Checklist

### 1. Configure GoCardless Credentials

Add these to your backend `.env` file:

```bash
# For sandbox testing
GOCARDLESS_ACCESS_TOKEN=your_sandbox_access_token
GOCARDLESS_ENVIRONMENT=sandbox
PORTAL_URL=https://portal.receptionmate.co.uk

# For production (when ready)
# GOCARDLESS_ACCESS_TOKEN=your_live_access_token
# GOCARDLESS_ENVIRONMENT=live
```

**Where to get credentials:**
- Login to GoCardless: https://manage.gocardless.com/
- Go to Developers → API Keys
- Copy your access token (sandbox for testing, live for production)

### 2. Set Frontend Environment Variable

Add to your frontend `.env.local`:

```bash
NEXT_PUBLIC_API_BASE_URL=https://api.receptionmate.co.uk
```

### 3. Test the Flow (Sandbox)

**a) Create a test user with payment required:**
```sql
UPDATE "User"
SET "mustSetupPayment" = true
WHERE email = 'test@example.com';
```

**b) Login with test user:**
- Should redirect to `/setup-payment`
- Click "Set Up Direct Debit"
- Should redirect to GoCardless hosted page

**c) Complete mandate in GoCardless:**
- Use test bank details (GoCardless provides these in sandbox)
- Complete the flow
- Should redirect back to `/setup-payment/callback`
- Should show success and redirect to `/calls`

**d) Verify in database:**
```sql
SELECT email, "mustSetupPayment", "gocardlessMandateId"
FROM "User"
WHERE email = 'test@example.com';
```

Should show:
- `mustSetupPayment` = false
- `gocardlessMandateId` = (mandate ID from GoCardless)

### 4. Production Launch

When ready to go live:

1. **Switch to live credentials:**
   ```bash
   GOCARDLESS_ACCESS_TOKEN=your_live_access_token
   GOCARDLESS_ENVIRONMENT=live
   ```

2. **Update PORTAL_URL if needed:**
   ```bash
   PORTAL_URL=https://portal.receptionmate.co.uk
   ```

3. **Mark users requiring payment:**
   ```sql
   UPDATE "User"
   SET "mustSetupPayment" = true
   WHERE "gocardlessMandateId" IS NULL;
   ```

4. **Restart backend:**
   ```bash
   npm run dev  # or your production restart command
   ```

## How It Works

1. **User logs in** → Backend checks `user.mustSetupPayment`
2. **If true** → Frontend receives `paymentSetupRequired: true` in login response
3. **Frontend redirects** → `/setup-payment` page
4. **User clicks button** → Backend creates GoCardless redirect flow
5. **GoCardless redirect** → User fills in bank details on GoCardless hosted page
6. **Callback** → GoCardless redirects to `/setup-payment/callback?redirect_flow_id=...`
7. **Confirm mandate** → Backend completes flow and saves mandate ID
8. **Update database** → Sets `mustSetupPayment = false`, stores mandate ID
9. **Success** → User redirected to `/calls` dashboard

## API Endpoints

- `POST /api/payment/create-mandate-flow` - Initiates GoCardless flow
- `POST /api/payment/confirm-mandate` - Confirms and saves mandate after redirect
- `GET /api/payment/mandate-status` - Checks current mandate status

## Frontend Pages

- `/setup-payment` - Landing page to start payment setup
- `/setup-payment/callback` - Handles GoCardless redirect and confirmation

## Database Fields

User model fields:
- `mustSetupPayment: Boolean` - If true, user must complete payment setup
- `gocardlessMandateId: String?` - Stored after successful setup
- `gocardlessCustomerId: String?` - GoCardless customer ID

## Troubleshooting

**Error: "GOCARDLESS_ACCESS_TOKEN is not configured"**
- Add the token to your backend `.env` file

**Error: "Invalid redirect URL"**
- Make sure `PORTAL_URL` in backend `.env` matches your actual portal URL
- GoCardless redirect URL must match exactly (no trailing slash)

**Mandate shows as pending**
- This is normal in sandbox - mandates can take a few days in production
- The code accepts `pending_submission`, `submitted`, and `active` statuses

**User stuck on payment setup page**
- Check database: `SELECT "mustSetupPayment", "gocardlessMandateId" FROM "User" WHERE email = '...'`
- If mandate exists but `mustSetupPayment` is still true, update manually:
  ```sql
  UPDATE "User" SET "mustSetupPayment" = false WHERE email = '...';
  ```

## Next Steps

1. Add environment variables to backend `.env`
2. Test in sandbox with a test user
3. Verify mandate appears in GoCardless dashboard
4. Switch to live credentials when ready
5. Mark all existing users as requiring payment setup
