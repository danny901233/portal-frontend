# EC2 Email Notification Debugging Guide

## Connect to EC2

```bash
ssh ec2-user@18.171.230.217
```

## Step 1: Check Environment Variables on EC2

```bash
cd /home/ec2-user/portal-frontend/backend

# Check if .env file exists and view email-related variables
cat .env | grep -E "MAILGUN|O365"

# If .env exists but no email variables, they're missing
# If .env doesn't exist, that's the problem
```

## Step 2: Check PM2 Environment

PM2 might be using environment variables directly instead of .env:

```bash
# List PM2 processes
pm2 list

# Check environment variables for the backend process (usually id 0 or named 'backend')
pm2 env 0

# Or show full details
pm2 show backend
```

## Step 3: Check Backend Logs

Look for email-related errors:

```bash
# View real-time logs
pm2 logs backend --lines 200

# Or check log files directly
pm2 show backend  # This shows log file paths

# Search for email-related messages
pm2 logs backend --lines 1000 | grep -i "email"
pm2 logs backend --lines 1000 | grep -i "mailgun\|o365\|notification"

# Check for the specific warning messages
pm2 logs backend --lines 1000 | grep "Email configuration missing"
pm2 logs backend --lines 1000 | grep "No notification emails configured"
```

## Step 4: Check Database Configuration

Connect to the production database:

```bash
# The DATABASE_URL should be in the .env file
cat .env | grep DATABASE_URL

# Connect to PostgreSQL
psql $DATABASE_URL

# Or if DATABASE_URL is not set, find it first:
cat .env
```

Once connected to PostgreSQL, run:

```sql
-- List all garages and their configurations
SELECT
  g.id,
  g.name,
  ac."branchName",
  ac."notificationEmails",
  array_length(ac."notificationEmails", 1) as email_count
FROM "Garage" g
LEFT JOIN "AgentConfiguration" ac ON g.id = ac."garageId"
ORDER BY g.name;

-- Check recent calls to see which garage is receiving calls
SELECT
  "garageId",
  COUNT(*) as call_count,
  MAX("createdAt") as last_call
FROM "Call"
GROUP BY "garageId"
ORDER BY last_call DESC;

-- Exit psql
\q
```

## Step 5: Fix Missing Email Configuration

### Option A: Add Mailgun Credentials

Edit the .env file on EC2:

```bash
cd /home/ec2-user/portal-frontend/backend
nano .env
```

Add these lines:

```bash
# Mailgun Configuration
MAILGUN_API_KEY=your_mailgun_api_key_here
MAILGUN_DOMAIN=your_domain.mailgun.org
MAILGUN_FROM=noreply@receptionmate.co.uk
```

Save (Ctrl+X, then Y, then Enter)

### Option B: Add Office 365 Credentials

```bash
# Office 365 Configuration
O365_SMTP_USER=your-email@receptionmate.co.uk
O365_SMTP_PASS=your_app_password_here
O365_FROM=your-email@receptionmate.co.uk
```

### Restart PM2 after editing .env

```bash
pm2 restart backend

# Verify it restarted successfully
pm2 status

# Watch logs to confirm no errors
pm2 logs backend --lines 50
```

## Step 6: Update Notification Emails in Database

```bash
# Connect to database
psql $DATABASE_URL
```

```sql
-- Update notification emails for each garage
-- Replace 'GARAGE_ID_HERE' with actual garage ID from Step 4
-- Replace 'your-email@example.com' with actual email addresses

UPDATE "AgentConfiguration"
SET "notificationEmails" = ARRAY['admin@receptionmate.co.uk', 'notifications@receptionmate.co.uk']
WHERE "garageId" = 'GARAGE_ID_HERE';

-- Verify the update
SELECT "garageId", "branchName", "notificationEmails"
FROM "AgentConfiguration"
WHERE "garageId" = 'GARAGE_ID_HERE';

-- Exit
\q
```

## Step 7: Test Email Sending

### Upload and run the diagnostic script:

From your local machine:

```bash
# Upload diagnostic script to EC2
scp /Users/dan/projects/portal-frontend/backend/scripts/diagnoseEmail.ts ec2-user@18.171.230.217:/home/ec2-user/portal-frontend/backend/scripts/

# SSH into EC2
ssh ec2-user@18.171.230.217

# Run diagnostic
cd /home/ec2-user/portal-frontend/backend
npx tsx scripts/diagnoseEmail.ts
```

### Trigger a test call

Create a test call to the system and watch logs in real-time:

```bash
# Watch logs in real-time
pm2 logs backend

# In another terminal window, trigger a test call
# Then watch for email send messages in the logs
```

## Step 8: Monitor for Success

After making changes, look for these messages in logs:

✅ **Success messages:**
```
Email sent successfully via Mailgun to: admin@example.com
```

❌ **Failure messages:**
```
Email configuration missing. Configure Mailgun or O365...
No notification emails configured, skipping email send
Failed to send email via Mailgun: 401 Unauthorized
```

## Common Issues & Solutions

### Issue 1: "Email configuration missing"
**Solution:** Add Mailgun or O365 credentials to .env file, then restart PM2

### Issue 2: "No notification emails configured"
**Solution:** Update AgentConfiguration in database with notification email addresses

### Issue 3: "Failed to send email via Mailgun: 401"
**Solution:** Check Mailgun API key is correct, verify domain is verified in Mailgun dashboard

### Issue 4: Email sends but not received
**Solution:** Check spam folder, verify email addresses are correct, check Mailgun dashboard for delivery logs

### Issue 5: .env changes not taking effect
**Solution:** Make sure to restart PM2 after editing .env: `pm2 restart backend`

## Quick Reference Commands

```bash
# SSH to EC2
ssh ec2-user@18.171.230.217

# Check logs
pm2 logs backend --lines 200

# Check environment
cat /home/ec2-user/portal-frontend/backend/.env

# Restart backend
pm2 restart backend

# Check status
pm2 status

# Connect to database
psql $DATABASE_URL
```
