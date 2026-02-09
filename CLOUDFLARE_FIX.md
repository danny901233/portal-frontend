# Fix for 403 Error on Payment Endpoint

## Problem
CloudFlare is blocking POST requests to `/api/payment/create-mandate-flow` with a 403 Forbidden error.

## Solution - CloudFlare Dashboard Settings

### Option 1: Create a WAF Exception (Recommended)
1. Log in to CloudFlare dashboard
2. Select the `receptionmate.co.uk` domain
3. Go to **Security** → **WAF**
4. Click **Create Exception**
5. Add these settings:
   - **When incoming requests match**:
     - Field: `URI Path`
     - Operator: `starts with`
     - Value: `/api/payment/`
   - **Then**: Skip all remaining rules
6. Save the exception

### Option 2: Adjust Security Level
1. Go to **Security** → **Settings**
2. Set **Security Level** to "Medium" or "Low" for the payment path
3. Or create a **Page Rule**:
   - URL pattern: `portal.receptionmate.co.uk/api/payment/*`
   - Setting: **Security Level** → **Medium**

### Option 3: Create a Firewall Rule
1. Go to **Security** → **WAF** → **Firewall Rules**
2. Click **Create a Firewall Rule**
3. Name: `Allow Payment API`
4. When incoming requests match:
   - Field: `URI Path`
   - Operator: `contains`
   - Value: `/api/payment/`
5. Then: **Allow**
6. Save and Deploy

### Option 4: Disable Bot Fight Mode for Payment Path
1. Go to **Security** → **Bots**
2. If Bot Fight Mode is enabled, create an exception for `/api/payment/*`

## Verification
After making changes:
1. Wait 1-2 minutes for changes to propagate
2. Test the "Set Up Direct Debit" button again
3. Check that you're redirected to GoCardless instead of getting a 403 error

## Temporary Bypass (Testing Only)
To confirm CloudFlare is the issue, you can temporarily bypass it by setting:
```
NEXT_PUBLIC_API_BASE_URL=http://18.171.230.217:4000
```

But this will cause mixed content errors in browsers, so it's only for testing. The proper fix is to adjust CloudFlare settings.
