# Email Notifications Fix - Summary

## 🎯 Root Cause Found

**The email configuration was REMOVED from the EC2 `.env` file**, likely during a recent deployment or update.

### Evidence:
1. ✅ Email code is working correctly (no bugs)
2. ✅ Database schema supports notification emails
3. ❌ `.env.example` has NO email configuration (template is incomplete)
4. ❌ Recent deployment on Feb 3, 2024 may have overwritten `.env`
5. ✅ You confirmed "it was working before" (= credentials were lost, not missing from start)

## 🔧 Quick Fix (Manual)

### Option 1: Manual Fix (5 minutes)

```bash
# 1. SSH to EC2
ssh ec2-user@18.171.230.217

# 2. Edit .env file
cd /home/ec2-user/portal-frontend/backend
nano .env

# 3. Add these lines (use your actual credentials):
# Email Configuration
MAILGUN_API_KEY=your_actual_key_here
MAILGUN_DOMAIN=your_actual_domain.mailgun.org
MAILGUN_FROM=noreply@receptionmate.co.uk

# 4. Save (Ctrl+X, Y, Enter)

# 5. Restart backend
pm2 restart backend

# 6. Verify
pm2 logs backend --lines 50
# Look for: "Email sent successfully via Mailgun"
```

### Option 2: Automated Fix (Interactive Script)

```bash
# From your local machine, run:
cd /Users/dan/projects/portal-frontend/backend
./scripts/restore-email-config.sh

# This will:
# - Prompt for your Mailgun credentials
# - Backup existing .env
# - Add email config to EC2 .env
# - Restart PM2
# - Show logs to verify
```

## 🔍 Finding Your Original Credentials

If you don't remember the Mailgun credentials:

### Check Mailgun Dashboard:
1. Go to https://app.mailgun.com/
2. Login with your ReceptionMate account
3. Navigate to **Sending → Domain settings**
4. Your API Key is under **API Keys** section

### Check Old Deployments:
```bash
# SSH to EC2
ssh ec2-user@18.171.230.217

# Check for backup .env files
ls -la /home/ec2-user/portal-frontend/backend/.env*

# If backups exist, check them:
cat /home/ec2-user/portal-frontend/backend/.env.backup*
```

### Check PM2 Environment (might still have it loaded):
```bash
ssh ec2-user@18.171.230.217
pm2 env backend | grep MAILGUN
```

### Check Git History (if .env was committed - unlikely but possible):
```bash
git log --all --full-history -- "backend/.env"
```

## 🛡️ Prevention - Changes Made

I've updated `.env.example` to include email configuration as a template:

```bash
# File: backend/.env.example
# Now includes:

# Email Configuration (REQUIRED for call notifications)
# Option 1: Mailgun (Recommended)
MAILGUN_API_KEY=your_mailgun_api_key
MAILGUN_DOMAIN=your_domain.mailgun.org
MAILGUN_FROM=noreply@yourdomain.com
```

**Commit this change** so future deployments won't lose email config:

```bash
git add backend/.env.example
git commit -m "Add email configuration template to prevent credential loss"
git push
```

## 📋 Verification Checklist

After restoring credentials:

- [ ] SSH to EC2: `ssh ec2-user@18.171.230.217`
- [ ] Verify .env has email vars: `grep MAILGUN /home/ec2-user/portal-frontend/backend/.env`
- [ ] Check PM2 loaded them: `pm2 env backend | grep MAILGUN`
- [ ] Check logs for success: `pm2 logs backend | grep -i email`
- [ ] Trigger test call and check email arrives
- [ ] Verify notification emails in database (see below)

## 🗄️ Database Configuration Check

Also verify the garages have notification emails configured:

```bash
ssh ec2-user@18.171.230.217
cd /home/ec2-user/portal-frontend/backend

# Get DATABASE_URL
source .env

# Check database
psql "$DATABASE_URL" -c "
SELECT
  g.name,
  ac.branchName,
  ac.notificationEmails
FROM Garage g
JOIN AgentConfiguration ac ON g.id = ac.garageId
ORDER BY g.name;
"
```

If `notificationEmails` is empty `[]`, update it:

```sql
UPDATE "AgentConfiguration"
SET "notificationEmails" = ARRAY['your-email@example.com', 'another@example.com']
WHERE "garageId" = 'your-garage-id-here';
```

## 📞 Support

If emails still don't work after restoring credentials:

1. **Check Mailgun Dashboard** - Verify domain is verified and not suspended
2. **Check Logs** - Look for specific error messages
3. **Test Mailgun API** directly:
   ```bash
   curl -s --user 'api:YOUR_MAILGUN_KEY' \
     https://api.mailgun.net/v3/YOUR_DOMAIN/messages \
     -F from='noreply@yourdomain.com' \
     -F to='test@example.com' \
     -F subject='Test Email' \
     -F text='Testing Mailgun'
   ```

4. **Check spam folder** - Emails might be delivering but caught by spam filters

## 📚 Helpful Scripts Created

- `backend/scripts/diagnoseEmail.ts` - Comprehensive diagnostic
- `backend/scripts/restore-email-config.sh` - Interactive restore
- `backend/scripts/check-ec2-email.sh` - Quick remote check
- `backend/scripts/ec2-debug-guide.md` - Step-by-step manual guide

## 🚀 Summary

**What happened:** Email credentials removed from EC2 `.env` during recent deployment/update

**Fix:** Restore Mailgun credentials to EC2 `.env` and restart PM2

**Prevention:** Updated `.env.example` to include email config template

**Time to fix:** ~5 minutes once you have the Mailgun credentials
