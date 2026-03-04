# ReceptionMate Onboarding Service

Automated provisioning service for Twilio numbers and LiveKit agent configuration.

## Overview

This service receives activation requests from the ReceptionMate portal and automatically:
1. Configures Twilio phone numbers to route calls to your LiveKit agent
2. Sets up voice webhooks and status callbacks
3. Logs provisioning details
4. (Optional) Sends confirmation emails

## Setup

### 1. Install Dependencies

```bash
cd onboarding-service
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set:

- **TWILIO_ACCOUNT_SID**: Your Twilio Account SID (from Twilio Console)
- **TWILIO_AUTH_TOKEN**: Your Twilio Auth Token (from Twilio Console)
- **LIVEKIT_AGENT_URL**: The public URL where your LiveKit agent receives calls (e.g., `https://agent.yourcompany.com/twilio-inbound`)
- **PORTAL_BASE_URL**: Your portal backend URL (e.g., `https://portal.yourcompany.com` or `http://18.171.230.217:4000`)
- **ONBOARDING_SECRET**: A random secret shared with your portal for authentication
- **PORT**: Port to run on (default: 5000)

### 3. Run Development Server

```bash
npm run dev
```

### 4. Build for Production

```bash
npm run build
npm start
```

## Connecting to Portal

Update your portal's `.env` to point to this service:

```bash
# In portal-frontend/backend/.env
ONBOARDING_SERVICE_URL=http://localhost:5000/provision
# or in production:
# ONBOARDING_SERVICE_URL=https://onboarding.yourcompany.com/provision
```

If you set `ONBOARDING_SECRET`, also add it to the portal backend and modify the portal's admin route to send it.

## API Endpoints

### POST `/provision`

Provisions a garage with Twilio configuration.

**Request Body:**
```json
{
  "garageId": "uuid",
  "garageName": "Branch Name",
  "branchName": "Branch Name",
  "contactEmail": "manager@garage.com",
  "contactPhone": "+1234567890",
  "twilioNumber": "+1987654321",
  "triggeredAt": "2025-12-30T10:00:00Z"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Garage activated successfully",
  "garageId": "uuid",
  "twilioNumber": "+1987654321"
}
```

### GET `/health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "service": "onboarding-service"
}
```

## Deployment Options

### Option 1: AWS EC2 (Same as Portal)

1. Copy service to EC2:
```bash
scp -r onboarding-service ec2-user@your-ec2-ip:~/
```

2. SSH and install:
```bash
ssh ec2-user@your-ec2-ip
cd onboarding-service
npm install
npm run build
```

3. Run with PM2:
```bash
pm2 start dist/server.js --name onboarding-service
pm2 save
```

### Option 2: Serverless (AWS Lambda)

Deploy as a Lambda function behind API Gateway. The Express app can be wrapped with `serverless-http`.

### Option 3: Docker

Create a `Dockerfile` and deploy to any container platform (ECS, Cloud Run, etc.).

## How It Works

1. Admin clicks "Activate Garage" in portal
2. Portal saves Twilio number and sends POST to this service
3. Service looks up the number in your Twilio account
4. Service configures the number's voice webhook to point to your LiveKit agent
5. Service returns success
6. LiveKit agent can now receive calls on that number
7. Agent pulls configuration from `GET /api/config/:garageId` on your portal
8. Completed calls are logged via `POST /api/calls` to your portal

## Troubleshooting

- **"Phone number not found in Twilio account"**: Make sure you've purchased the number in Twilio first
- **"LIVEKIT_AGENT_URL not configured"**: Set the URL where your agent receives Twilio webhooks
- **401 errors**: Check that `ONBOARDING_SECRET` matches in both portal and this service
