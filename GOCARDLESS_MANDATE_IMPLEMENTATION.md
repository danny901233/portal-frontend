# GoCardless Direct Debit Mandate Implementation

## Project Context

You are working on the ReceptionMate portal (portal.receptionmate.co.uk), a Next.js frontend with Express/Prisma backend that manages AI voice agents for businesses.

## Accessing the Codebase

### Repository Information
- **Repository**: danny901233/portal-frontend
- **Branch**: receptionmate-demo-branch-2
- **Location**: `/Users/dan/projects/portal-frontend`

### Project Structure
```
portal-frontend/
├── app/                          # Next.js 13+ app directory (frontend)
│   ├── login/page.tsx           # Login page with password change flow
│   ├── reset-password/page.tsx  # Password reset page
│   ├── lib/
│   │   ├── api.ts              # API client functions
│   │   └── auth.ts             # Auth utilities (persistSession, etc)
│   └── types/index.ts          # TypeScript types
├── backend/
│   ├── src/
│   │   ├── server.ts           # Main Express server
│   │   ├── db.ts               # Prisma client
│   │   ├── routes/
│   │   │   ├── auth.ts         # Authentication endpoints (/api/login, /api/forgot-password, /api/reset-password)
│   │   │   └── admin.ts        # Admin endpoints including onboarding
│   │   ├── middleware/
│   │   │   └── auth.ts         # JWT authentication middleware
│   │   └── utils/
│   │       └── validators.ts   # Zod schemas for validation
│   └── package.json
├── onboarding-service/
│   └── src/server.ts           # Separate service for SIP trunk provisioning
└── prisma/
    └── schema.prisma           # Database schema

```

### Backend Services
1. **Main Backend**: Runs on port 5000 (production: https://portal.receptionmate.co.uk/api)
2. **Onboarding Service**: Runs on port 5001 (handles SIP trunk provisioning)
3. **Frontend**: Next.js on port 3000 (production: https://portal.receptionmate.co.uk)

### Environment Variables
Check `.env` file in `/Users/dan/projects/portal-frontend/` for:
- `DATABASE_URL` - PostgreSQL connection
- `JWT_SECRET` - JWT signing key
- `ONBOARDING_API_KEY` - API key for onboarding endpoints
- Add: `GOCARDLESS_ACCESS_TOKEN` - Your GoCardless API token
- Add: `GOCARDLESS_ENVIRONMENT` - Either "sandbox" or "live"

## Current Authentication Flow

### Existing Password Change Flow
1. User logs in with email/password
2. Backend checks `user.mustChangePassword` flag
3. If true:
   - Generates `resetToken` and `resetTokenExpiry`
   - Returns `{ passwordChangeRequired: true, resetToken, user }`
4. Frontend redirects to `/reset-password?token={resetToken}`
5. User sets new password
6. `mustChangePassword` flag set to `false`
7. User can now access the portal

### Relevant Files
- **Backend**: `/backend/src/routes/auth.ts` (lines 34-51 handle mustChangePassword logic)
- **Frontend**: `/app/login/page.tsx` (lines 26-33 handle passwordChangeRequired response)
- **Database**: User model has `mustChangePassword Boolean @default(false)`

## Required Implementation

### Objective
Extend the first-login flow to require GoCardless Direct Debit mandate setup AFTER password change but BEFORE portal access.

### User Flow
1. New user logs in → forced to change password (existing)
2. After password change → forced to complete GoCardless DD mandate (NEW)
3. After mandate completed → full portal access granted

### Technical Requirements

#### 1. Database Schema Changes (`prisma/schema.prisma`)
Add to User model:
```prisma
model User {
  // ... existing fields ...
  mustChangePassword Boolean @default(false)
  mustSetupPayment   Boolean @default(false)  // NEW
  gocardlessMandateId String?                 // NEW - store mandate reference
  gocardlessCustomerId String?                // NEW - store customer reference
  // ... rest of fields ...
}
```

#### 2. Backend API Endpoints (`backend/src/routes/`)

Create new file `backend/src/routes/payment.ts`:

**POST /api/payment/create-mandate-flow**
- Authenticated endpoint (requires JWT)
- Creates GoCardless customer using user email
- Initiates mandate flow
- Returns redirect URL for GoCardless hosted pages
- Store `gocardlessCustomerId` on User record

**POST /api/payment/confirm-mandate**
- Authenticated endpoint
- Receives mandate ID from GoCardless callback
- Verifies mandate is active
- Updates User: `gocardlessMandateId = {id}`, `mustSetupPayment = false`
- Returns success

**GET /api/payment/mandate-status**
- Authenticated endpoint
- Checks if user has active mandate
- Returns `{ hasMandate: boolean, mandateId?: string }`

#### 3. Update Login Response (`backend/src/routes/auth.ts`)

Modify login endpoint to check both flags:
```typescript
// After password check passes
if (user.mustChangePassword) {
  // ... existing resetToken logic ...
  return res.json({
    success: true,
    passwordChangeRequired: true,
    resetToken,
    user: { /* ... */ }
  });
}

// NEW: Check payment setup requirement
if (user.mustSetupPayment) {
  return res.json({
    success: true,
    paymentSetupRequired: true,
    user: { /* ... */ }
  });
}

// ... continue with normal login ...
```

#### 4. Frontend Payment Setup Page

Create new page: `app/setup-payment/page.tsx`

Components needed:
- Page explaining Direct Debit requirement
- Button to "Set Up Direct Debit"
- Redirect to GoCardless hosted page
- Handle return from GoCardless (success/failure)
- Call `/api/payment/confirm-mandate` on success
- Redirect to `/calls` when complete

#### 5. Update Login Page Logic (`app/login/page.tsx`)

Add handling for new response:
```typescript
onSuccess: (data: LoginResponse) => {
  // ... existing passwordChangeRequired check ...
  
  // NEW: Check payment setup requirement
  if (data.paymentSetupRequired) {
    router.push('/setup-payment');
    return;
  }
  
  // ... existing normal login flow ...
}
```

#### 6. Update Onboarding API (`backend/src/routes/admin.ts`)

When creating new users via `/api/admin/onboard`:
```typescript
const newUser = await prisma.user.create({
  data: {
    email: parsed.data.userEmail,
    passwordHash: hashedPassword,
    mustChangePassword: true,
    mustSetupPayment: true,  // NEW - require payment setup
    // ... rest of fields ...
  }
});
```

#### 7. TypeScript Types (`app/types/index.ts`)

Update LoginResponse type:
```typescript
export interface LoginResponse {
  success: boolean;
  token?: string;
  user?: {
    id: string;
    email: string;
    role: string;
    branchRoles: Record<string, string>;
  };
  passwordChangeRequired?: boolean;
  paymentSetupRequired?: boolean;  // NEW
  resetToken?: string;
  selectedGarageId?: string;
  garages?: Array<{ id: string; name: string }>;
}
```

### GoCardless Integration Details

#### SDK Installation
```bash
cd /Users/dan/projects/portal-frontend/backend
npm install gocardless-nodejs
```

#### Initialize Client (in `backend/src/routes/payment.ts`)
```typescript
import * as gocardless from 'gocardless-nodejs';

const gocardlessClient = gocardless(
  process.env.GOCARDLESS_ACCESS_TOKEN!,
  gocardless.constants.Environments.Sandbox  // or Live
);
```

#### Create Redirect Flow
```typescript
const redirectFlow = await gocardlessClient.redirectFlows.create({
  description: 'ReceptionMate Monthly Subscription',
  session_token: user.id,  // Unique per user session
  success_redirect_url: 'https://portal.receptionmate.co.uk/setup-payment/callback',
  prefilled_customer: {
    email: user.email,
    // optional: company_name, given_name, family_name
  }
});

// Return redirectFlow.redirect_url to frontend
```

#### Complete Flow (on callback)
```typescript
const completedFlow = await gocardlessClient.redirectFlows.complete(
  redirectFlowId,
  { session_token: user.id }
);

// Store these:
const mandateId = completedFlow.links.mandate;
const customerId = completedFlow.links.customer;
```

### Migration Script

Create `prisma/migrations/[timestamp]_add_payment_fields/migration.sql`:
```sql
ALTER TABLE "User" ADD COLUMN "mustSetupPayment" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "gocardlessMandateId" TEXT;
ALTER TABLE "User" ADD COLUMN "gocardlessCustomerId" TEXT;

-- Set existing users to not require payment setup (grandfather clause)
UPDATE "User" SET "mustSetupPayment" = false WHERE "createdAt" < NOW();
```

## Implementation Checklist

- [ ] Add GoCardless SDK to backend dependencies
- [ ] Update Prisma schema with payment fields
- [ ] Run migration to add columns
- [ ] Create `backend/src/routes/payment.ts` with 3 endpoints
- [ ] Update `backend/src/routes/auth.ts` login logic
- [ ] Update `backend/src/routes/admin.ts` onboarding logic
- [ ] Mount payment router in `backend/src/server.ts`
- [ ] Update `app/types/index.ts` with new types
- [ ] Create `app/setup-payment/page.tsx`
- [ ] Create `app/setup-payment/callback/page.tsx` (handles GoCardless return)
- [ ] Update `app/login/page.tsx` to handle paymentSetupRequired
- [ ] Add environment variables for GoCardless
- [ ] Test new user onboarding flow end-to-end

## Testing Instructions

### 1. Test with New User (Full Flow)
```bash
# Create test user via API
curl -X POST https://portal.receptionmate.co.uk/api/admin/onboard \
  -H "X-API-Key: TEjP3VTnh1WsdWbTBD4cCbeMymXpYhB0ELjMhjYmzso=" \
  -H "Content-Type: application/json" \
  -d '{
    "businessName": "Test Garage Ltd",
    "branchName": "Main Branch",
    "userEmail": "test@example.com",
    "userPassword": "initialpass123"
  }'

# Expected flow:
# 1. Login with test@example.com / initialpass123
# 2. Redirected to /reset-password → set new password
# 3. Redirected to /setup-payment → complete GoCardless mandate
# 4. Redirected to /calls → full access granted
```

### 2. Verify Database State
```sql
-- Check user has both flags initially
SELECT email, "mustChangePassword", "mustSetupPayment", "gocardlessMandateId" 
FROM "User" 
WHERE email = 'test@example.com';

-- After password change: mustChangePassword = false, mustSetupPayment = true
-- After payment setup: both false, gocardlessMandateId populated
```

### 3. Test Existing Users (Should Not Be Affected)
Existing users should have `mustSetupPayment = false` and not be interrupted.

## Security Considerations

1. **Session Token**: Use user.id as GoCardless session token - prevents session hijacking
2. **Mandate Verification**: Always verify mandate with GoCardless API before marking complete
3. **Idempotency**: Handle duplicate callback requests gracefully
4. **Error Handling**: If mandate setup fails, allow retry without losing progress
5. **Audit Trail**: Log all payment setup attempts and completions

## GoCardless Webhook (Optional Future Enhancement)

Set up webhook to receive mandate status changes:
- Mandate cancelled by customer
- Mandate failed
- Payment failures

This allows you to update user status and potentially restrict portal access if mandate becomes inactive.

## References

- GoCardless Node.js SDK: https://github.com/gocardless/gocardless-nodejs
- GoCardless API Docs: https://developer.gocardless.com/api-reference/
- Redirect Flow Guide: https://developer.gocardless.com/getting-started/billing-requests/redirect-flows/

## Questions to Resolve

1. **What monthly amount should be collected?** Define pricing structure
2. **Should mandate setup be optional for certain user roles?** (e.g., RECEPTIONMATE_STAFF)
3. **Grace period?** Should users get X days/calls before mandate is required?
4. **Retry limit?** How many times can user abandon mandate setup before account locked?
5. **Grandfather existing customers?** Should current users be exempt from mandate requirement?
ok
---

**Implementation Priority**: HIGH
**Estimated Effort**: 6-8 hours
**Dependencies**: GoCardless account with API credentials
