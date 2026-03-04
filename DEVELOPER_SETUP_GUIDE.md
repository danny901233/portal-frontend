# Developer Setup Guide - ReceptionMate Portal

This guide covers everything a new developer needs to work on the ReceptionMate portal, including credentials, access, and setup instructions.

---

## Overview

The ReceptionMate portal consists of:
- **Frontend:** Next.js 14 (TypeScript, TailwindCSS)
- **Backend:** Node.js/Express (TypeScript, Prisma ORM)
- **Database:** PostgreSQL
- **Hosting:** AWS EC2 (18.171.230.217)

---

## Table of Contents

1. [Required Access & Credentials](#required-access--credentials)
2. [Repository Access](#repository-access)
3. [Environment Variables](#environment-variables)
4. [Local Development Setup](#local-development-setup)
5. [Database Access](#database-access)
6. [Production Server Access](#production-server-access)
7. [Third-Party Services](#third-party-services)
8. [Deployment](#deployment)
9. [Security Best Practices](#security-best-practices)

---

## Required Access & Credentials

### 1. GitHub Repository Access

**Repository:** `danny901233/portal-frontend`  
**Branch:** `receptionmate-demo-branch-2` (main working branch)

**Required:**
- GitHub account
- Repository access (read/write permissions)
- SSH key or personal access token configured

---

### 2. AWS EC2 Server Access

**Production Server:** `18.171.230.217`  
**SSH Key:** `ReceptionMatebackend.pem`

**Access Command:**
```bash
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.230.217
```

**What you need:**
- The `.pem` private key file
- SSH client (included on Mac/Linux, use PuTTY on Windows)

---

### 3. Database Access

**Production Database:**
- **Host:** (likely same EC2 or managed PostgreSQL instance)
- **Port:** 5432 (default PostgreSQL)
- **Database Name:** (from DATABASE_URL)
- **Username:** (from DATABASE_URL)
- **Password:** (from DATABASE_URL)

**Connection String Format:**
```
postgresql://username:password@host:5432/database_name
```

**Tools you'll need:**
- Prisma CLI (included in project)
- PostgreSQL client (optional: pgAdmin, DBeaver, TablePlus)

---

### 4. Third-Party Service Credentials

These are stored in environment variables (`.env` files):

#### Twilio (Phone System)
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- Used for: Phone number management, call routing

#### GoCardless (Payment Processing)
- `GOCARDLESS_ACCESS_TOKEN`
- `GOCARDLESS_WEBHOOK_SECRET`
- `GOCARDLESS_ENVIRONMENT` (sandbox or live)
- Used for: Direct Debit payments, invoicing

#### OpenAI
- `OPENAI_API_KEY`
- Used for: Call summaries, chat assistance

#### ElevenLabs (Voice Synthesis)
- `ELEVENLABS_API_KEY`
- Used for: Agent voice preview

#### Meta (WhatsApp/Facebook/Instagram)
- `META_WEBHOOK_VERIFY_TOKEN`
- `META_APP_SECRET`
- `META_ACCESS_TOKEN`
- Used for: Messaging integrations

#### SendGrid (Email)
- `SENDGRID_API_KEY`
- `FROM_EMAIL`
- Used for: Welcome emails, password resets, billing notifications

#### LiveKit (Voice Agent Platform)
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_SIP_DOMAIN`
- Used for: Real-time voice agent connections

#### AWS (Optional - for agent config)
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION` or `AWS_DEFAULT_REGION`
- Used for: DynamoDB agent configuration storage

---

## Repository Access

### Clone the Repository

```bash
# Using SSH (recommended)
git clone git@github.com:danny901233/portal-frontend.git
cd portal-frontend

# Using HTTPS
git clone https://github.com/danny901233/portal-frontend.git
cd portal-frontend
```

### Switch to Working Branch

```bash
git checkout receptionmate-demo-branch-2
```

---

## Environment Variables

### Frontend Environment Variables

Create `.env.local` in the project root:

```bash
# API Backend URL
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
NEXT_PUBLIC_API_URL=http://localhost:4000

# For production, use:
# NEXT_PUBLIC_API_BASE_URL=http://18.171.230.217:4000
# NEXT_PUBLIC_API_URL=http://18.171.230.217:4000
```

---

### Backend Environment Variables

Create `backend/.env`:

```bash
# ============================================================
# SERVER
# ============================================================
PORT=4000
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000,https://portal.receptionmate.co.uk

# ============================================================
# DATABASE
# ============================================================
DATABASE_URL="postgresql://username:password@localhost:5432/receptionmate_portal"

# ============================================================
# AUTHENTICATION
# ============================================================
JWT_SECRET="your-secret-jwt-key-change-in-production"

# ============================================================
# PORTAL
# ============================================================
PORTAL_URL=http://localhost:3000
PORTAL_BASE_URL=http://localhost:3000

# ============================================================
# WEBHOOKS
# ============================================================
WEBHOOK_SECRET="optional-shared-secret-for-agent-webhooks"
AGENT_CONFIG_WEBHOOK_SECRET="different-secret-for-config-sync"
AGENT_CONFIG_WEBHOOK_URL="http://localhost:3002/webhook/agent-config"

# ============================================================
# TWILIO (Phone System)
# ============================================================
TWILIO_ACCOUNT_SID="AC..."
TWILIO_AUTH_TOKEN="..."
LIVEKIT_SIP_DOMAIN="sip.livekit.cloud"
LIVEKIT_SIP_DOMAIN_ASSIST="sip-assist.livekit.cloud"
LIVEKIT_SIP_DOMAIN_AUTOMATE="sip-automate.livekit.cloud"

# ============================================================
# GOCARDLESS (Payment Processing)
# ============================================================
GOCARDLESS_ACCESS_TOKEN="sandbox_..."
GOCARDLESS_WEBHOOK_SECRET="..."
GOCARDLESS_ENVIRONMENT="sandbox"  # or "live" for production

# ============================================================
# OPENAI
# ============================================================
OPENAI_API_KEY="sk-..."

# ============================================================
# ELEVENLABS (Voice Preview)
# ============================================================
ELEVENLABS_API_KEY="..."

# ============================================================
# META (WhatsApp/Facebook/Instagram)
# ============================================================
META_WEBHOOK_VERIFY_TOKEN="your-verify-token"
META_APP_SECRET="..."
META_ACCESS_TOKEN="..."

# ============================================================
# EMAIL (SendGrid)
# ============================================================
SENDGRID_API_KEY="SG...."
FROM_EMAIL="noreply@receptionmate.co.uk"

# ============================================================
# LIVEKIT (Voice Agent)
# ============================================================
LIVEKIT_API_KEY="..."
LIVEKIT_API_SECRET="..."

# ============================================================
# ONBOARDING SERVICE
# ============================================================
ONBOARDING_SERVICE_URL="http://localhost:3002"
ONBOARDING_SECRET="shared-secret-for-onboarding"

# ============================================================
# AWS (Optional - for DynamoDB agent config)
# ============================================================
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
AWS_REGION="eu-west-2"
AWS_DEFAULT_REGION="eu-west-2"

# ============================================================
# AGENT SETTINGS (Optional)
# ============================================================
BASIC_AGENT_SETTINGS_PATH="../.next/agent/agent_settings.env"
```

---

## Local Development Setup

### Prerequisites

1. **Node.js 18+** and **npm 9+**
   ```bash
   node --version  # Should be 18.x or higher
   npm --version   # Should be 9.x or higher
   ```

2. **PostgreSQL 14+**
   ```bash
   # On macOS (using Homebrew)
   brew install postgresql@14
   brew services start postgresql@14
   
   # On Ubuntu/Debian
   sudo apt install postgresql-14
   sudo systemctl start postgresql
   ```

---

### Step 1: Install Dependencies

```bash
# From project root
npm install

# This installs both frontend and backend dependencies
```

---

### Step 2: Set Up Database

```bash
# Create database
createdb receptionmate_portal

# Or using psql
psql postgres
CREATE DATABASE receptionmate_portal;
\q
```

Update `DATABASE_URL` in `backend/.env`:
```bash
DATABASE_URL="postgresql://your-username:your-password@localhost:5432/receptionmate_portal"
```

---

### Step 3: Run Database Migrations

```bash
# Generate Prisma client
npx prisma generate

# Run migrations
npx prisma migrate deploy

# Or for development (creates migration files)
npx prisma migrate dev
```

---

### Step 4: Seed Database (Optional)

Create test data:
```bash
npx prisma db seed
```

---

### Step 5: Start Development Servers

**Option 1: Run frontend and backend separately**

```bash
# Terminal 1 - Frontend (Next.js)
npm run dev
# Runs on http://localhost:3000

# Terminal 2 - Backend (Express)
cd backend
npm run dev
# Runs on http://localhost:4000
```

**Option 2: Use PM2 to run both**

```bash
# Install PM2 globally
npm install -g pm2

# Start both services
pm2 start ecosystem.config.js

# View logs
pm2 logs

# Stop all
pm2 stop all
```

---

### Step 6: Verify Setup

1. **Frontend:** Open http://localhost:3000
2. **Backend Health:** http://localhost:4000/health
3. **Backend API Docs:** Check `API_ENDPOINTS_DOCUMENTATION.md`

---

## Database Access

### Using Prisma Studio (GUI)

```bash
npx prisma studio
```
Opens at http://localhost:5555 - visual database browser

---

### Using Prisma CLI

```bash
# Query data
npx prisma db execute --stdin <<EOF
SELECT * FROM "User" LIMIT 10;
EOF

# Create user
npx prisma db execute --stdin <<EOF
INSERT INTO "User" (id, email, "passwordHash")
VALUES ('test-id', 'test@example.com', 'hash-here');
EOF

# Delete user
npx prisma db execute --stdin <<EOF
DELETE FROM "User" WHERE email = 'test@example.com';
EOF
```

---

### Using Direct psql Connection

```bash
# Connect to local database
psql receptionmate_portal

# Or using DATABASE_URL
psql "postgresql://username:password@localhost:5432/receptionmate_portal"

# Common commands
\dt              # List tables
\d "User"        # Describe User table
SELECT * FROM "User" LIMIT 10;
\q               # Quit
```

---

## Production Server Access

### SSH into Production Server

```bash
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.230.217
```

---

### Production File Locations

```bash
# Application code
/home/ec2-user/portal-frontend/

# Environment variables
/home/ec2-user/portal-frontend/.env.local          # Frontend
/home/ec2-user/portal-frontend/backend/.env        # Backend

# Logs
pm2 logs backend    # Backend logs
pm2 logs frontend   # Frontend logs (if using PM2)

# Or check journalctl
sudo journalctl -u backend -n 100
```

---

### Common Production Commands

```bash
# Check service status
pm2 status

# View logs
pm2 logs backend --lines 100

# Restart services
pm2 restart backend
pm2 restart frontend

# Pull latest code
cd /home/ec2-user/portal-frontend
git pull origin receptionmate-demo-branch-2

# Install dependencies
npm install

# Rebuild
npm run build

# Run database migrations
npx prisma migrate deploy

# Restart
pm2 restart all
```

---

### Deploy Script (if available)

```bash
# From local machine
./deploy-to-ec2.sh

# Or SSH and pull manually
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.230.217
cd portal-frontend
git pull
npm install
npm run build
pm2 restart all
```

---

## Third-Party Services

### How to Get Credentials

1. **Twilio**
   - Console: https://console.twilio.com
   - Account SID and Auth Token in dashboard
   - Purchase phone numbers under "Phone Numbers"

2. **GoCardless**
   - Dashboard: https://manage.gocardless.com
   - Create API token under "Developers" > "Access tokens"
   - Use sandbox for testing: https://manage-sandbox.gocardless.com

3. **OpenAI**
   - Platform: https://platform.openai.com
   - API Keys under "API keys" section
   - Billing: Set up payment method

4. **ElevenLabs**
   - Dashboard: https://elevenlabs.io
   - API key in profile settings

5. **Meta (WhatsApp/Facebook/Instagram)**
   - Developer Portal: https://developers.facebook.com
   - Create app → Get App ID and App Secret
   - WhatsApp Business API requires approval

6. **SendGrid**
   - Dashboard: https://app.sendgrid.com
   - API Keys under Settings > API Keys
   - Verify sender email address

---

## Deployment

### Manual Deployment to Production

```bash
# 1. SSH into server
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.230.217

# 2. Navigate to project
cd /home/ec2-user/portal-frontend

# 3. Pull latest code
git pull origin receptionmate-demo-branch-2

# 4. Install dependencies
npm install

# 5. Run database migrations
npx prisma migrate deploy

# 6. Build frontend
npm run build

# 7. Restart services
pm2 restart all

# 8. Verify
pm2 status
curl http://localhost:4000/health
```

---

### Automated Deployment (CI/CD)

If using GitHub Actions or similar:

1. Set up secrets in GitHub repository settings
2. Create `.github/workflows/deploy.yml`
3. Configure SSH access to EC2
4. Trigger on push to main branch

---

## Security Best Practices

### 1. Never Commit Secrets

```bash
# Add to .gitignore (should already be there)
.env
.env.local
backend/.env
*.pem
*.key
```

---

### 2. Use Environment-Specific Credentials

- **Development:** Sandbox/test credentials
- **Production:** Live credentials with restricted permissions

---

### 3. Credential Storage Options

**Option A: 1Password/LastPass (Recommended)**
- Create shared vault for team
- Store all credentials with tags
- Share vault access with developers

**Option B: AWS Secrets Manager**
- Store secrets in AWS
- Fetch at runtime
- Rotate automatically

**Option C: Encrypted File on Shared Drive**
- Encrypt `.env` files with GPG
- Store on Google Drive / Dropbox
- Developers decrypt locally

**Option D: Password-Protected Document**
- Create Excel/Word doc with all credentials
- Password protect the file
- Share file + password separately

---

### 4. SSH Key Management

```bash
# On developer's machine
chmod 600 ~/Downloads/ReceptionMatebackend.pem

# Never share via:
- Email attachments
- Slack/Discord
- GitHub
- Public cloud storage

# Share via:
- 1Password (secure notes)
- Encrypted email
- In-person USB transfer
```

---

### 5. Rotate Secrets Regularly

- Change JWT_SECRET every 90 days
- Rotate API keys quarterly
- Update SSH keys annually
- Change passwords monthly

---

## Recommended Setup for New Developer

### Checklist

- [ ] Get GitHub repository access
- [ ] Clone repository
- [ ] Install Node.js 18+
- [ ] Install PostgreSQL 14+
- [ ] Get `.env` files (all credentials)
- [ ] Get SSH key (ReceptionMatebackend.pem)
- [ ] Run `npm install`
- [ ] Set up local database
- [ ] Run `npx prisma migrate deploy`
- [ ] Start development servers
- [ ] Access localhost:3000 (frontend)
- [ ] Test localhost:4000/health (backend)
- [ ] Read documentation:
  - [ ] API_ENDPOINTS_DOCUMENTATION.md
  - [ ] ONBOARDING_PROCESS.md
  - [ ] AGENT_INTEGRATION_GUIDE.md
- [ ] Join team communication (Slack/Discord)
- [ ] Schedule onboarding call

---

## Credential Distribution Methods

### Recommended Approach: 1Password Shared Vault

**Setup:**
1. Create 1Password account (team or business plan)
2. Create shared vault: "ReceptionMate Development"
3. Add all credentials as items:
   - "Production Database" → username, password, host
   - "Twilio Credentials" → Account SID, Auth Token
   - "AWS EC2 SSH Key" → Attach `.pem` file
   - "GoCardless API" → Access token, webhook secret
   - etc.
4. Share vault with developer
5. Developer downloads 1Password and accesses vault

**Advantages:**
- Secure end-to-end encryption
- Easy to update credentials (everyone gets updates)
- Audit log of who accessed what
- Can revoke access instantly
- Works on all devices

---

### Alternative: Encrypted Zip File

**Setup:**
```bash
# Create folder with all files
mkdir receptionmate-credentials
cp .env.local receptionmate-credentials/
cp backend/.env receptionmate-credentials/backend.env
cp ~/Downloads/ReceptionMatebackend.pem receptionmate-credentials/
cp CREDENTIALS.md receptionmate-credentials/  # Document explaining each credential

# Create encrypted zip
zip -er receptionmate-credentials.zip receptionmate-credentials/
# Enter password when prompted

# Share zip file via Google Drive/Dropbox
# Send password via separate channel (SMS, phone call, Signal)
```

**Developer extracts:**
```bash
unzip receptionmate-credentials.zip
# Enter password
mv receptionmate-credentials/.env.local ./portal-frontend/
mv receptionmate-credentials/backend.env ./portal-frontend/backend/.env
mv receptionmate-credentials/ReceptionMatebackend.pem ~/Downloads/
chmod 600 ~/Downloads/ReceptionMatebackend.pem
```

---

## Getting Help

### Documentation Files

- `README.md` - Project overview and basic setup
- `API_ENDPOINTS_DOCUMENTATION.md` - Complete API reference
- `ONBOARDING_PROCESS.md` - Business onboarding system
- `AGENT_INTEGRATION_GUIDE.md` - Agent → portal integration
- `DEVELOPER_SETUP_GUIDE.md` - This file

---

### Useful Commands Reference

```bash
# Frontend
npm run dev              # Start dev server
npm run build            # Production build
npm run start            # Start production server
npm run lint             # Run linter

# Backend
cd backend && npm run dev    # Start backend dev server
npx prisma studio            # Open database GUI
npx prisma migrate dev       # Create new migration
npx prisma migrate deploy    # Apply migrations

# Database
npx prisma db execute --stdin <<EOF
SELECT * FROM "User";
EOF

# Production
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.230.217
pm2 status
pm2 logs backend
pm2 restart all

# Git
git status
git pull origin receptionmate-demo-branch-2
git add .
git commit -m "Description"
git push origin receptionmate-demo-branch-2
```

---

## Support Contact

For access issues or questions:
- Email: [your-email]
- Slack/Discord: [team channel]
- GitHub Issues: https://github.com/danny901233/portal-frontend/issues

---

## Version History

**v1.0** (February 2026)
- Initial developer setup guide
- Complete credential list
- Local development instructions
- Production deployment guide
