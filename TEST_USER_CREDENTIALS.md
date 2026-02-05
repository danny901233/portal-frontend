# Test User for Payment Setup Flow

## Test Credentials

**Email:** `test.payment@receptionmate.co.uk`
**Password:** `TestPayment123`

## User Status
✅ Created with `mustSetupPayment = true`
✅ No existing mandate
✅ Access to garage granted
✅ Password change NOT required

## Testing the Payment Flow

### Prerequisites
Make sure you have these environment variables set in your backend `.env`:

```bash
GOCARDLESS_ACCESS_TOKEN=your_sandbox_token
GOCARDLESS_ENVIRONMENT=sandbox
PORTAL_URL=https://portal.receptionmate.co.uk
JWT_SECRET=your_jwt_secret
```

### Step-by-Step Test

1. **Login with test user**
   - Go to your login page
   - Email: `test.payment@receptionmate.co.uk`
   - Password: `TestPayment123!`
   - Click Login

2. **Expected: Redirect to payment setup**
   - Should automatically redirect to `/setup-payment`
   - Should see "Set Up Direct Debit" page
   - Should show GoCardless information

3. **Click "Set Up Direct Debit"**
   - Should redirect to GoCardless hosted page
   - You'll see a form to enter bank details

4. **Use GoCardless Sandbox Test Bank**
   - In sandbox, use these test details:
     - **Account Number:** 55779911
     - **Sort Code:** 200000
     - Or any account number between 00000000-99999999
   - Complete the form

5. **Expected: Success redirect**
   - After submitting, GoCardless redirects to `/setup-payment/callback`
   - Should show "Processing Payment Setup" spinner
   - Then "Payment Setup Complete!" success message
   - Auto-redirect to `/calls` dashboard after 2 seconds

6. **Verify in database**
   ```bash
   cd backend && node -e "
   const { PrismaClient } = require('.prisma/client');
   const prisma = new PrismaClient();
   prisma.user.findUnique({
     where: { email: 'test.payment@receptionmate.co.uk' }
   }).then(user => {
     console.log('mustSetupPayment:', user.mustSetupPayment);
     console.log('gocardlessMandateId:', user.gocardlessMandateId);
     prisma.\$disconnect();
   });
   "
   ```

   Should show:
   - `mustSetupPayment: false`
   - `gocardlessMandateId: RE00xxxxx` (actual mandate ID)

7. **Test login again**
   - Logout and login with same credentials
   - Should go directly to dashboard (NOT payment setup)

## Reset Test User

If you want to test again, reset the user:

```bash
cd backend && node -e "
const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();
prisma.user.update({
  where: { email: 'test.payment@receptionmate.co.uk' },
  data: {
    mustSetupPayment: true,
    gocardlessMandateId: null,
    gocardlessCustomerId: null
  }
}).then(() => {
  console.log('✅ Test user reset - ready for testing again');
  prisma.\$disconnect();
});
"
```

## Troubleshooting

### "GOCARDLESS_ACCESS_TOKEN is not configured"
- Check your backend `.env` file has the token
- Restart your backend server

### Stays on login page / doesn't redirect
- Check browser console for errors
- Verify `NEXT_PUBLIC_API_BASE_URL` is set in frontend `.env.local`
- Check backend logs for errors

### "Failed to initiate payment setup"
- Check backend logs for detailed error
- Verify GoCardless credentials are correct
- Make sure you're using sandbox environment

### Success but mandate not saved
- Check backend logs during callback
- Verify database connection is working
- Try resetting the user and testing again

## GoCardless Sandbox Resources

- **Dashboard:** https://manage-sandbox.gocardless.com/
- **Test Bank Details:** https://developer.gocardless.com/getting-started/developer-tools/test-bank-details/
- **Webhook Testing:** Can be tested later with ngrok/tunneling

## Next Steps After Testing

1. Verify mandate appears in GoCardless sandbox dashboard
2. Test cancellation flow (if implemented)
3. Test webhook notifications (optional)
4. When ready, switch to live credentials and test with real bank account
