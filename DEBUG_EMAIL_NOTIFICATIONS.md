# Debug Email Notifications - ReceptionMate Portal

## Project Context

You are debugging why email notifications are not being sent from the ReceptionMate portal (portal.receptionmate.co.uk). The system should send call summary emails after each call is completed, but they are not arriving.

## Accessing the Codebase

### Repository Information
- **Repository**: danny901233/portal-frontend
- **Branch**: receptionmate-demo-branch-2
- **Location**: `/Users/dan/projects/portal-frontend`

### Relevant Files
```
portal-frontend/
├── backend/
│   ├── src/
│   │   ├── server.ts                    # Express server, check startup logs
│   │   ├── routes/
│   │   │   ├── calls.ts                 # Line 215: sendCallSummaryEmail triggered here
│   │   │   └── auth.ts                  # Password reset emails
│   │   └── utils/
│   │       ├── email.ts                 # Email sending logic (Mailgun + O365)
│   │       └── reportEmails.ts          # Report email functions
│   └── package.json
├── prisma/
│   └── schema.prisma                    # Check Call and AgentConfiguration models
└── .env                                 # Email provider credentials
```

### Production Environment
- **Backend**: https://portal.receptionmate.co.uk/api (EC2: 18.171.230.217)
- **Deployment**: PM2 managed process on EC2
- **Database**: PostgreSQL (connection string in .env)

## Email System Overview

### How It Works
1. **Call Completion** → POST `/api/calls` receives call data
2. **Lookup Config** → Fetches `AgentConfiguration.notificationEmails` for the garage
3. **Send Email** → Calls `sendCallSummaryEmail()` with recipient list
4. **Email Providers**: Tries Mailgun first, falls back to Office 365 SMTP

### Email Provider Configuration

**Mailgun (Primary)**:
```bash
MAILGUN_API_KEY=your_key
MAILGUN_DOMAIN=your_domain  
MAILGUN_FROM=noreply@yourdomain.com
MAILGUN_API_BASE=https://api.mailgun.net  # optional
```

**Office 365 (Fallback)**:
```bash
O365_SMTP_HOST=smtp.office365.com
O365_SMTP_PORT=587
O365_SMTP_USER=your@email.com
O365_SMTP_PASS=your_password
O365_FROM=your@email.com
```

## Debugging Checklist

### Step 1: Check Environment Variables on EC2

SSH into EC2 and verify email credentials:

```bash
ssh ec2-user@18.171.230.217
cd /home/ec2-user/portal-frontend/backend

# Check if variables are set
grep -E "MAILGUN|O365" .env

# Or check PM2 environment
pm2 env 0  # Replace 0 with your backend process ID
```

**Expected Variables**: At least one email provider (Mailgun OR O365) must be fully configured.

**Common Issue**: Missing credentials will cause silent failures.

### Step 2: View Backend Logs

Check PM2 logs for email-related messages:

```bash
# View real-time logs
pm2 logs backend --lines 200

# Or check specific log files
pm2 show backend  # Shows log file paths
tail -f /path/to/pm2/logs/backend-out.log
tail -f /path/to/pm2/logs/backend-error.log

# Search for email-related logs
grep -i "email" /path/to/pm2/logs/backend-out.log | tail -50
grep -i "mailgun\|o365\|notification" /path/to/pm2/logs/backend-out.log | tail -50
```

**Look for**:
- ✅ `"Email sent successfully via Mailgun to: ..."`
- ✅ `"Email sent successfully via O365 to: ..."`
- ❌ `"Email configuration missing. Configure Mailgun or O365..."`
- ❌ `"Failed to send email via Mailgun: ..."`
- ❌ `"No notification emails configured, skipping email send"`

### Step 3: Check Database Configuration

Verify the garage has notification emails configured:

```bash
# Connect to PostgreSQL
psql $DATABASE_URL

# Check specific garage configuration
SELECT 
  "garageId",
  "branchName",
  "notificationEmails",
  "callSummaryEmail"
FROM "AgentConfiguration"
WHERE "garageId" = '4f73c11e-53f5-4591-8531-00717d099f17';

# Check if any calls were created for this garage
SELECT 
  id,
  "createdAt",
  "garageId",
  "customerName",
  summary
FROM "Call"
WHERE "garageId" = '4f73c11e-53f5-4591-8531-00717d099f17'
ORDER BY "createdAt" DESC
LIMIT 10;
```

**Common Issues**:
- `notificationEmails` is `[]` (empty array)
- `notificationEmails` is `null`
- Emails contain typos or invalid addresses

### Step 4: Test Email Sending Manually

Create a test script to verify email provider connectivity:

```typescript
// backend/scripts/testEmail.ts
import { sendEmail } from '../src/utils/email.js';

async function testEmail() {
  const result = await sendEmail({
    to: ['your-test-email@example.com'],
    subject: 'ReceptionMate Email Test',
    html: '<h1>Test Email</h1><p>If you receive this, email system is working!</p>',
    text: 'Test Email\n\nIf you receive this, email system is working!',
  });

  console.log('Email send result:', result);
}

testEmail().catch(console.error);
```

Run it:
```bash
cd /Users/dan/projects/portal-frontend/backend
npx tsx scripts/testEmail.ts
```

### Step 5: Check Code Logic in calls.ts

Verify the email sending code is actually being executed:

```bash
# Check if the code path is reached
grep -A 20 "sendCallSummaryEmail" backend/src/routes/calls.ts
```

**Key checks**:
1. Is `agentConfiguration` being found?
2. Is `notificationEmails` array populated?
3. Is the `void sendCallSummaryEmail()` call being made?
4. Are there any try-catch blocks swallowing errors?

### Step 6: Inspect Email Provider Responses

Add temporary logging to `backend/src/utils/email.ts`:

**Mailgun debugging** (around line 55):
```typescript
const response = await fetch(`${config.apiBase}/v3/${config.domain}/messages`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${Buffer.from(`api:${config.apiKey}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: form.toString(),
});

console.log('Mailgun response status:', response.status);
const responseText = await response.text();
console.log('Mailgun response body:', responseText);

if (!response.ok) {
  console.error('Failed to send email via Mailgun:', response.status, responseText);
  return false;
}
```

**O365 debugging** (around line 85):
```typescript
const transport = nodemailer.createTransport({
  host: config.host,
  port: config.port,
  secure: config.port === 465,
  auth: {
    user: config.user,
    pass: config.pass,
  },
  requireTLS: true,
});

console.log('Attempting O365 send with config:', {
  host: config.host,
  port: config.port,
  from: config.from,
  to: options.to,
});

const info = await transport.sendMail({
  from: config.from,
  to: options.to.join(', '),
  subject: options.subject,
  text: options.text,
  html: options.html,
});

console.log('O365 send result:', info);
```

Rebuild and restart after adding logs:
```bash
npm run build
pm2 restart backend
```

## Common Root Causes

### 1. **Missing Environment Variables** (Most Common)
- `.env` file not loaded by PM2
- Variables not exported in PM2 ecosystem config
- **Fix**: Use PM2 ecosystem file or dotenv in server.ts

### 2. **Empty Notification Emails Array**
- Admin hasn't configured notification emails for the garage
- **Fix**: Update via admin portal or database directly:
```sql
UPDATE "AgentConfiguration" 
SET "notificationEmails" = ARRAY['admin@example.com']
WHERE "garageId" = '4f73c11e-53f5-4591-8531-00717d099f17';
```

### 3. **Mailgun Domain Not Verified**
- Domain verification pending in Mailgun dashboard
- **Fix**: Verify domain or use Mailgun sandbox domain for testing

### 4. **O365 Authentication Failures**
- Modern auth required instead of basic auth
- App password needed if 2FA enabled
- **Fix**: Generate app-specific password in Microsoft account settings

### 5. **Email Caught in Spam**
- Emails sending but going to spam/junk folder
- **Fix**: Check recipient spam folder, configure SPF/DKIM records

### 6. **Async Error Swallowing**
- `void sendCallSummaryEmail()` means errors are not awaited
- Failures happen silently without throwing
- **Fix**: Check logs for error messages caught in `.catch()`

### 7. **Firewall/Network Issues on EC2**
- Outbound SMTP port 587 blocked
- **Fix**: Check EC2 security group allows outbound on 587, 465, 443

## Diagnostic Script

Run this comprehensive check:

```typescript
// backend/scripts/diagnoseEmail.ts
import { prisma } from '../src/db.js';
import { sendCallSummaryEmail } from '../src/utils/email.js';

async function diagnose() {
  const garageId = '4f73c11e-53f5-4591-8531-00717d099f17';
  
  console.log('=== Email Notification Diagnostic ===\n');
  
  // 1. Check environment
  console.log('1. Environment Variables:');
  console.log('   MAILGUN_API_KEY:', process.env.MAILGUN_API_KEY ? '✓ Set' : '✗ Missing');
  console.log('   MAILGUN_DOMAIN:', process.env.MAILGUN_DOMAIN ? '✓ Set' : '✗ Missing');
  console.log('   MAILGUN_FROM:', process.env.MAILGUN_FROM ? '✓ Set' : '✗ Missing');
  console.log('   O365_SMTP_USER:', process.env.O365_SMTP_USER ? '✓ Set' : '✗ Missing');
  console.log('   O365_SMTP_PASS:', process.env.O365_SMTP_PASS ? '✓ Set' : '✗ Missing');
  
  // 2. Check database config
  console.log('\n2. Garage Configuration:');
  const config = await prisma.agentConfiguration.findUnique({
    where: { garageId },
  });
  
  if (!config) {
    console.log('   ✗ No configuration found for garage');
    return;
  }
  
  console.log('   Branch Name:', config.branchName);
  console.log('   Notification Emails:', config.notificationEmails);
  console.log('   Email Count:', Array.isArray(config.notificationEmails) ? config.notificationEmails.length : 0);
  
  // 3. Check recent calls
  console.log('\n3. Recent Calls:');
  const calls = await prisma.call.findMany({
    where: { garageId },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  
  console.log(`   Found ${calls.length} recent calls`);
  calls.forEach((call, i) => {
    console.log(`   ${i + 1}. ${call.createdAt.toISOString()} - ${call.customerName || 'Unknown'}`);
  });
  
  // 4. Test send
  if (config.notificationEmails && config.notificationEmails.length > 0) {
    console.log('\n4. Sending Test Email...');
    const testResult = await sendCallSummaryEmail(config.notificationEmails, {
      branchName: config.branchName,
      summary: 'This is a test email to verify notification system',
      transcript: [
        { role: 'agent', message: 'Hello, this is a test call', timestamp: 0 },
        { role: 'user', message: 'Yes, I can hear you', timestamp: 2 }
      ],
      durationSeconds: 45,
      callType: 'inbound',
      customerName: 'Test Customer',
      customerPhone: '+447700900000',
      createdAt: new Date().toISOString(),
    });
    
    console.log('   Test Result:', testResult ? '✓ SUCCESS' : '✗ FAILED');
  } else {
    console.log('\n4. ✗ Cannot test - no notification emails configured');
  }
}

diagnose()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

Run it:
```bash
cd /Users/dan/projects/portal-frontend/backend
npx tsx scripts/diagnoseEmail.ts
```

## Expected Output Analysis

### ✅ Working System
```
Email sent successfully via Mailgun to: admin@example.com
```

### ❌ Missing Config
```
Email configuration missing. Configure Mailgun or O365 SMTP to enable sending.
No notification emails configured, skipping email send
```

### ❌ Provider Failure
```
Failed to send email via Mailgun: 401 Unauthorized
Attempting O365 fallback.
Failed to send email via O365: Error: Invalid login
```

## Quick Fixes

### If no emails configured in database:
```sql
UPDATE "AgentConfiguration" 
SET "notificationEmails" = ARRAY['your-email@example.com']
WHERE "garageId" = '4f73c11e-53f5-4591-8531-00717d099f17';
```

### If environment variables missing:
```bash
# Edit .env file
nano /home/ec2-user/portal-frontend/backend/.env

# Add credentials, then restart
pm2 restart backend
```

### If emails going to spam:
1. Check spam folder first
2. Add sender to contacts/safe senders
3. Configure SPF/DKIM in DNS for production use

## Next Steps After Diagnosis

1. **Share diagnostic output** - Run the diagnostic script and share results
2. **Check specific garage** - Verify `4f73c11e-53f5-4591-8531-00717d099f17` has emails configured
3. **Review PM2 logs** - Check for errors during actual call processing
4. **Test email providers** - Verify credentials work independently
5. **Monitor new calls** - Create a test call and watch logs in real-time

---

**Priority**: HIGH  
**Impact**: Customer notifications not working  
**Estimated Debug Time**: 30-60 minutes
