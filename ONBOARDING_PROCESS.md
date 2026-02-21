# ReceptionMate Onboarding Process Documentation

## Overview

The ReceptionMate onboarding system creates a complete business setup including business entity, branch, agent configuration, user account, and optional Twilio phone number provisioning. The process is designed to be fully automated and configurable for different trial types and billing models.

---

## API Endpoint

**POST** `/api/onboarding/create-business`

**Authentication:** Requires `X-API-Key` header

**Base URL:** `http://18.171.230.217:4000/api` (production)

---

## Request Schema

```json
{
  "branchName": "string (1-200 chars, required)",
  "contactName": "string (1-200 chars, required)",
  "contactEmail": "string (email format, required)",
  "websiteUrl": "string (valid URL, required)",
  "agentType": "assist | automate (required)",
  "subscriptionCostGbp": "number (≥0, required)",
  "includedMinutes": "number (integer ≥0, default: 400)",
  "trialType": "days | bookings (optional)",
  "trialDays": "number (integer ≥0, optional)",
  "requireBookings": "number (integer ≥0, optional)",
  "autoPurchaseTwilioNumber": "boolean (default: true)",
  "activateTwilio": "boolean (default: true)"
}
```

### Field Descriptions

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `branchName` | string | Yes | - | Name of the garage/branch (e.g., "Manchester Motors") |
| `contactName` | string | Yes | - | Primary contact person's full name |
| `contactEmail` | string | Yes | - | Email for login and notifications |
| `websiteUrl` | string | Yes | - | Business website for scraping contact info |
| `agentType` | enum | Yes | - | "assist" (human handoff) or "automate" (full booking) |
| `subscriptionCostGbp` | number | Yes | - | Monthly subscription fee in GBP |
| `includedMinutes` | number | No | 400 | Number of included minutes per month |
| `trialType` | enum | No | - | Trial activation type: "days" or "bookings" |
| `trialDays` | number | No | - | Trial duration in days (if trialType="days") |
| `requireBookings` | number | No | - | Bookings needed to activate (if trialType="bookings") |
| `autoPurchaseTwilioNumber` | boolean | No | true | Auto-purchase UK phone number |
| `activateTwilio` | boolean | No | true | Activate Twilio provisioning |

---

## Onboarding Flow Steps

### 1. Twilio Number Purchase (Optional)
- **Condition:** `autoPurchaseTwilioNumber = true`
- **Action:** Automatically purchases a random available UK phone number from Twilio
- **Fallback:** If purchase fails, continues without phone number (warning logged)

### 2. Business Creation
Creates a `Business` entity with:
- Business name (same as branch name)
- Contact name
- Contact email
- Empty contact phone (can be updated later)
- Contact role: "Owner"

### 3. Garage/Branch Creation
Creates a `Garage` entity with:
- Branch name
- Link to business entity
- Twilio phone number (if purchased)
- **Billing Configuration:**
  - `subscriptionCostGbp`: From request
  - `includedMinutes`: From request (default 400)
  - `costPerMinuteGbp`: **Always £0.25** (hardcoded)
  - `vatRate`: **Always 20%** (hardcoded)
- **Trial Configuration:**
  - `trialEndDate`: Calculated if `trialType="days"`
  - `requiresBookingActivation`: `true` if `trialType="bookings"`
  - `bookingsRequiredForActivation`: From `requireBookings` field
  - `activationBookingsCount`: 0 (initial)
  - `subscriptionActivatedAt`: null (will be set when trial completes)

### 4. Agent Configuration Creation
Creates an `AgentConfiguration` with:

**Basic Info:**
- `garageId`: Link to created garage
- `branchName`: From request
- `agentType`: "assist" or "automate"

**Contact Details (from website scraping):**
- `phoneNumber`: Extracted from website
- `emailAddress`: From website
- `branchAddress`: From website
- `weeklyOpeningHours`: Parsed from website text

**Agent Behavior (Optimized Defaults):**
- `greetingLine`: `"[timeofday], {branchName}, Leah speaking, how can I help?"`
- `tonePreference`: "upbeat"
- `responseSpeed`: "fast"
- `interruptionSensitivity`: 0.3 (low = faster agent responses)
- `allowFastFitOnly`: false
- `notificationEmails`: [contactEmail]
- `integrationProvider`: "none"
- `enableSmsBookingLinks`: true

**Website Info:**
- `websiteUrl`: From request

### 5. Website Scraping
- **Tool:** Uses internal scraper to fetch website content
- **Extracted Data:**
  - Phone number (regex patterns)
  - Email address (regex patterns)
  - Physical address (pattern matching)
  - Opening hours (text parsing with day/time detection)
- **Parsing:** Converts text hours to structured JSON format
- **Fallback:** If scraping fails, fields remain empty/null

### 6. User Account Creation
Creates a `User` entity with:
- `email`: Contact email (lowercased)
- `passwordHash`: BCrypt hash of standard password
- **Standard Password:** `"Nomoremissedcalls"` (all users get same initial password)
- `mustChangePassword`: **true** (enforced on first login)
- `mustSetupPayment`: **true** (always required, even for trial users)
- `garageAccessIds`: [garage.id]
- `role`: "USER"
- `branchRoles`: { [garage.id]: "MANAGER" }

### 7. Welcome Email
Sends automated email with:
- Login credentials
- Portal URL: `https://portal.receptionmate.co.uk`
- Business/branch name
- Password: `Nomoremissedcalls`
- Instructions to change password on first login

**Note:** Email failure does NOT fail the onboarding process (logged as warning)

### 8. Twilio Provisioning (Optional)
- **Condition:** `activateTwilio = true` AND Twilio number exists
- **Action:** Calls onboarding service to provision SIP routing
- **Endpoint:** `ONBOARDING_SERVICE_URL/provision`
- **Payload:**
  ```json
  {
    "garageId": "uuid",
    "garageName": "string",
    "branchName": "string",
    "contactEmail": "string",
    "twilioNumber": "+44...",
    "agentName": "receptionmate-agent-v3",
    "triggeredAt": "ISO timestamp"
  }
  ```
- **Fallback:** If provisioning fails, warning logged but onboarding succeeds

---

## Response Format

### Success Response (201 Created)

```json
{
  "success": true,
  "message": "Business onboarded successfully",
  "data": {
    "business": {
      "id": "uuid",
      "name": "Manchester Motors",
      "contactName": "John Smith",
      "contactEmail": "john@example.com"
    },
    "branch": {
      "id": "uuid",
      "name": "Manchester Motors",
      "twilioNumber": "+441234567890"
    },
    "user": {
      "id": "uuid",
      "email": "john@example.com",
      "temporaryPassword": "Nomoremissedcalls"
    },
    "billing": {
      "subscriptionCostGbp": 400,
      "includedMinutes": 400,
      "costPerMinuteGbp": 0.25,
      "vatRate": 0.20,
      "trialEndDate": "2026-03-07T00:00:00.000Z",
      "requiresBookingActivation": false,
      "bookingsRequiredForActivation": 0
    },
    "agentConfig": {
      "id": "uuid",
      "agentType": "assist",
      "greeting": "Good afternoon, Manchester Motors, Leah speaking, how can I help?",
      "tonePreference": "upbeat",
      "responseSpeed": "fast",
      "websiteUrl": "https://example.com",
      "scannedData": {
        "phoneNumber": "01234567890",
        "address": "123 Main St, Manchester",
        "openingHours": {
          "monday": { "open": "09:00", "close": "17:00" },
          "tuesday": { "open": "09:00", "close": "17:00" }
        }
      }
    }
  },
  "warnings": []
}
```

### Error Response (400/500)

```json
{
  "error": "string",
  "message": "string (optional)",
  "details": {} // Optional validation errors
}
```

### Possible Warnings

Array of strings that appear in `warnings` field when non-critical issues occur:
- `"Failed to purchase Twilio number"` - Auto-purchase failed, manual setup needed
- `"Twilio provisioning failed"` - SIP routing setup failed, manual configuration needed

---

## Trial Types

### 1. Days-Based Trial
**Configuration:**
```json
{
  "trialType": "days",
  "trialDays": 14
}
```

**Behavior:**
- Sets `trialEndDate` to current date + N days
- `requiresBookingActivation`: false
- Subscription activates automatically after trial period
- User can make unlimited bookings during trial

### 2. Bookings-Based Trial
**Configuration:**
```json
{
  "trialType": "bookings",
  "requireBookings": 4
}
```

**Behavior:**
- No `trialEndDate` set
- `requiresBookingActivation`: true
- `bookingsRequiredForActivation`: N
- Subscription activates after N successful bookings
- Trial has no time limit

### 3. No Trial (Immediate Activation)
**Configuration:**
```json
{
  // Don't include trialType field
}
```

**Behavior:**
- No trial period
- Billing starts immediately
- `subscriptionActivatedAt` set to current date

---

## Billing Configuration

### Fixed Values (Always Applied)
- **Cost per minute:** £0.25 (cannot be changed via API)
- **VAT rate:** 20% (cannot be changed via API)

### Variable Values (From Request)
- **Monthly subscription:** `subscriptionCostGbp`
- **Included minutes:** `includedMinutes` (default: 400)

### Billing Calculation Example
```
Subscription: £400/month
Included: 400 minutes
Over-limit: £0.25/minute

Month usage: 450 minutes
Base charge: £400
Overage: (450-400) × £0.25 = £12.50
Subtotal: £412.50
VAT (20%): £82.50
Total: £495.00
```

---

## Default Password Security

**Standard Password:** `Nomoremissedcalls`

**Security Measures:**
1. **Forced Change:** `mustChangePassword = true` blocks all actions until password is changed
2. **Payment Required:** `mustSetupPayment = true` requires GoCardless mandate setup
3. **Email Delivery:** Password sent via secure welcome email
4. **One-Time Use:** User must change on first login

**Why Single Password?**
- Simplifies customer communication
- Reduces support burden
- Forced change ensures security
- Consistent across all onboardings

---

## Website Scraping Details

### What Gets Scraped
1. **Phone Number**
   - Patterns: UK landline/mobile formats
   - Priority: First valid number found
   - Example: "01234 567890", "07123 456789"

2. **Email Address**
   - Standard email regex
   - Example: "info@example.com"

3. **Physical Address**
   - Multi-line address detection
   - Postcode validation
   - Example: "123 High St\nManchester\nM1 1AA"

4. **Opening Hours**
   - Day name detection (Monday-Sunday)
   - Time format parsing (12h/24h)
   - Range detection (09:00-17:00)
   - Closed day handling
   - Example output:
     ```json
     {
       "monday": { "open": "09:00", "close": "17:00" },
       "saturday": { "open": "09:00", "close": "13:00" },
       "sunday": "closed"
     }
     ```

### Scraping Failure Handling
- Fields remain `null` if scraping fails
- Onboarding continues successfully
- Admin can manually update values later
- No error thrown for missing data

---

## Common Use Cases

### 1. Standard 14-Day Trial
```bash
curl -X POST http://18.171.230.217:4000/api/onboarding/create-business \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "branchName": "Manchester Motors",
    "contactName": "John Smith",
    "contactEmail": "john@example.com",
    "websiteUrl": "https://example.com",
    "agentType": "assist",
    "subscriptionCostGbp": 400,
    "includedMinutes": 400,
    "trialType": "days",
    "trialDays": 14,
    "autoPurchaseTwilioNumber": true,
    "activateTwilio": true
  }'
```

### 2. Booking-Based Activation (4 bookings)
```bash
curl -X POST http://18.171.230.217:4000/api/onboarding/create-business \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "branchName": "Quick Fit Centre",
    "contactName": "Jane Doe",
    "contactEmail": "jane@quickfit.com",
    "websiteUrl": "https://quickfit.com",
    "agentType": "automate",
    "subscriptionCostGbp": 300,
    "includedMinutes": 300,
    "trialType": "bookings",
    "requireBookings": 4,
    "autoPurchaseTwilioNumber": true,
    "activateTwilio": true
  }'
```

### 3. No Trial (Immediate Billing)
```bash
curl -X POST http://18.171.230.217:4000/api/onboarding/create-business \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "branchName": "Elite Garage",
    "contactName": "Bob Wilson",
    "contactEmail": "bob@elite.com",
    "websiteUrl": "https://elite.com",
    "agentType": "assist",
    "subscriptionCostGbp": 500,
    "includedMinutes": 500,
    "autoPurchaseTwilioNumber": false,
    "activateTwilio": false
  }'
```

---

## Database Schema

### Business Table
```prisma
model Business {
  id              String   @id @default(uuid())
  name            String
  contactName     String
  contactEmail    String
  contactPhone    String
  contactRole     String
  garages         Garage[]
}
```

### Garage Table
```prisma
model Garage {
  id                              String    @id @default(uuid())
  name                            String
  businessId                      String?
  twilioNumber                    String?
  hasMessagingAccess              Boolean   @default(false)
  
  // Billing
  subscriptionCostGbp             Float     @default(0)
  includedMinutes                 Int       @default(0)
  costPerMinuteGbp                Float     @default(0)
  vatRate                         Float     @default(0.20)
  
  // Trial/Activation
  trialEndDate                    DateTime?
  requiresBookingActivation       Boolean   @default(false)
  bookingsRequiredForActivation   Int       @default(0)
  activationBookingsCount         Int       @default(0)
  subscriptionActivatedAt         DateTime?
  
  // Setup
  setupWizardCompleted            Boolean   @default(false)
  setupWizardCompletedAt          DateTime?
  
  business                        Business? @relation(fields: [businessId], references: [id])
  agentConfiguration              AgentConfiguration?
  calls                           Call[]
  customers                       Customer[]
}
```

### User Table
```prisma
model User {
  id                      String    @id @default(cuid())
  email                   String    @unique
  passwordHash            String
  mustChangePassword      Boolean   @default(false)
  mustSetupPayment        Boolean   @default(false)
  gocardlessMandateId     String?
  gocardlessCustomerId    String?
  billingCycleStartDate   DateTime?
  nextBillingDate         DateTime?
  garageAccessIds         String[]  @default([])
  role                    UserRole  @default(USER)
  branchRoles             Json      @default("{}")
  createdAt               DateTime  @default(now())
  updatedAt               DateTime  @updatedAt
  
  // Onboarding
  setupWizardCompleted    Boolean   @default(false)
  setupWizardCompletedAt  DateTime?
}
```

### AgentConfiguration Table
```prisma
model AgentConfiguration {
  id                      String  @id @default(cuid())
  garageId                String  @unique
  branchName              String
  phoneNumber             String?
  emailAddress            String?
  branchAddress           String?
  websiteUrl              String?
  weeklyOpeningHours      Json?
  holidayClosures         String?
  greetingLine            String?
  tonePreference          String  @default("standard")
  responseSpeed           String  @default("normal")
  interruptionSensitivity Float   @default(0.5)
  allowFastFitOnly        Boolean @default(false)
  notificationEmails      String[]
  integrationProvider     String  @default("none")
  agentType               String  @default("assist")
  enableSmsBookingLinks   Boolean @default(true)
  
  garage                  Garage  @relation(fields: [garageId], references: [id])
}
```

---

## Post-Onboarding User Journey

### 1. First Login
1. User receives welcome email with credentials
2. Navigates to `https://portal.receptionmate.co.uk/login`
3. Enters email and password (`Nomoremissedcalls`)
4. System detects `mustChangePassword = true`
5. Redirected to password change screen
6. Must set new password before accessing portal

### 2. Payment Setup
1. After password change, detects `mustSetupPayment = true`
2. Redirected to GoCardless mandate setup
3. Must complete Direct Debit authorization
4. System stores `gocardlessCustomerId` and `gocardlessMandateId`
5. Only then can access full portal

### 3. Setup Wizard (Optional)
1. If `setupWizardCompleted = false`, shows wizard
2. User can configure:
   - Agent voice and tone
   - Opening hours
   - Contact details
   - Integration settings
3. Marks `setupWizardCompleted = true` when done
4. Can skip and complete later

### 4. Portal Access
- Full access to dashboard
- Can view calls
- Can manage settings
- Can access billing info
- Can update agent config

---

## Environment Variables

Required environment variables for onboarding:

```bash
# Database
DATABASE_URL="postgresql://..."

# Twilio (for phone number purchase)
TWILIO_ACCOUNT_SID="AC..."
TWILIO_AUTH_TOKEN="..."

# Onboarding Service (for SIP provisioning)
ONBOARDING_SERVICE_URL="https://..."
ONBOARDING_SERVICE_SECRET="..." # Optional

# Email (for welcome emails)
SENDGRID_API_KEY="SG..."
FROM_EMAIL="noreply@receptionmate.co.uk"

# Portal
PORTAL_URL="https://portal.receptionmate.co.uk"

# Auth
JWT_SECRET="..."
API_KEY="..." # For X-API-Key authentication
```

---

## Error Handling

### User Already Exists
**Error Code:** 500  
**Message:** "Unique constraint failed on the fields: (`email`)"  
**Cause:** Email already registered  
**Solution:** Delete existing user or use different email

### Invalid Request Data
**Error Code:** 400  
**Message:** "Invalid request"  
**Details:** Zod validation errors  
**Solution:** Check request schema matches documentation

### Twilio Purchase Failed
**Error Code:** 201 (Warning in response)  
**Warning:** "Failed to purchase Twilio number"  
**Impact:** Onboarding succeeds without phone number  
**Solution:** Manually purchase and assign number later

### Provisioning Failed
**Error Code:** 201 (Warning in response)  
**Warning:** "Twilio provisioning failed"  
**Impact:** Onboarding succeeds but SIP routing not configured  
**Solution:** Manually trigger provisioning or check onboarding service

---

## Testing

### Test Command (with example API key)
```bash
export ONBOARDING_API_KEY="test-api-key-123"

curl -X POST http://localhost:4000/api/onboarding/create-business \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ONBOARDING_API_KEY" \
  -d '{
    "branchName": "Test Garage",
    "contactName": "Test User",
    "contactEmail": "test@example.com",
    "websiteUrl": "https://example.com",
    "agentType": "assist",
    "subscriptionCostGbp": 400,
    "includedMinutes": 400,
    "trialType": "days",
    "trialDays": 14,
    "autoPurchaseTwilioNumber": false,
    "activateTwilio": false
  }'
```

### Expected Test Login
- Email: `test@example.com`
- Password: `Nomoremissedcalls`
- Must change password on first login
- Must setup payment (GoCardless)

---

## Support and Troubleshooting

### Common Issues

**1. Email not received**
- Check spam folder
- Verify SendGrid API key
- Check `FROM_EMAIL` is configured
- View backend logs for email errors

**2. Phone number not working**
- Verify Twilio credentials
- Check number provisioning logs
- Ensure onboarding service is running
- Manually provision in Twilio console

**3. User can't login**
- Verify email is correct (case-sensitive)
- Ensure user exists in database
- Check password is `Nomoremissedcalls`
- Verify JWT_SECRET is set

**4. Trial not activating**
- Check `trialEndDate` or `bookingsRequiredForActivation`
- Verify booking count increments
- Check `subscriptionActivatedAt` timestamp
- Review billing logs

### Log Locations

**Backend logs:**
```bash
# PM2 logs
pm2 logs backend

# Journalctl (if systemd)
sudo journalctl -u backend -n 100
```

**Database queries:**
```sql
-- Check user
SELECT * FROM "User" WHERE email = 'test@example.com';

-- Check garage billing
SELECT id, name, "subscriptionCostGbp", "trialEndDate", 
       "requiresBookingActivation", "activationBookingsCount"
FROM "Garage" WHERE id = 'garage-uuid';

-- Check agent config
SELECT * FROM "AgentConfiguration" WHERE "garageId" = 'garage-uuid';
```

---

## Version History

**Current Version:** v1.0 (February 2026)

**Recent Changes:**
- Implemented comprehensive onboarding endpoint
- Added website scraping for contact info
- Auto-purchase Twilio numbers
- Standardized password to "Nomoremissedcalls"
- Added trial type configuration (days/bookings)
- Fixed £0.25/min billing rate

---

## Contact

For issues or questions:
- Email: hello@receptionmate.co.uk
- Portal: https://portal.receptionmate.co.uk
- Documentation: This file
