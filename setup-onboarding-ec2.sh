#!/bin/bash
# Run this script on EC2 to set up the onboarding service
# Usage: bash setup-onboarding-ec2.sh

set -e

echo "🚀 Setting up onboarding service on EC2..."

# Navigate to project directory
cd /home/ec2-user/portal-frontend

# Pull latest code
echo "📥 Pulling latest code..."
git pull origin receptionmate-demo-branch-2

# Set up onboarding service environment
echo "🔧 Configuring onboarding service .env..."
cd onboarding-service

# Check if .env already exists
if [ -f .env ]; then
  echo "⚠️  .env file already exists. Skipping creation."
  echo "    If you need to update credentials, edit onboarding-service/.env manually"
else
  echo "⚠️  .env file not found!"
  echo "    Please create onboarding-service/.env with the following variables:"
  echo "    PORT=5000"
  echo "    TWILIO_ACCOUNT_SID=your_account_sid"
  echo "    TWILIO_AUTH_TOKEN=your_auth_token"
  echo "    LIVEKIT_AGENT_URL=sip:n4s20ufg0v7.sip.livekit.cloud"
  echo "    LIVEKIT_URL=wss://n4s20ufg0v7.livekit.cloud"
  echo "    LIVEKIT_API_KEY=your_api_key"
  echo "    LIVEKIT_API_SECRET=your_api_secret"
  echo "    PORTAL_BASE_URL=http://18.171.223.223:4000"
  echo "    ONBOARDING_SECRET=ob-secret-7h9k2m4p6q8r1s3t5v"
  echo ""
  read -p "Press Enter to continue after creating .env file..."
fi

# Install dependencies and build
echo "📦 Installing dependencies..."
npm install

echo "🔨 Building..."
npm run build

# Update backend .env
echo "🔧 Updating backend .env..."
cd ../backend

# Add ONBOARDING_SERVICE_URL if not present
if ! grep -q "ONBOARDING_SERVICE_URL" .env 2>/dev/null; then
  echo "" >> .env
  echo "ONBOARDING_SERVICE_URL=http://localhost:5000/provision" >> .env
fi

# Add ONBOARDING_SECRET if not present
if ! grep -q "ONBOARDING_SECRET" .env 2>/dev/null; then
  echo "ONBOARDING_SECRET=ob-secret-7h9k2m4p6q8r1s3t5v" >> .env
fi

# Start/restart services with PM2
echo "🔄 Starting services..."
cd ../onboarding-service

# Delete if exists, ignore errors
pm2 delete onboarding-service 2>/dev/null || true

# Start onboarding service
pm2 start npm --name "onboarding-service" -- start

# Restart backend to pick up new environment variables
pm2 restart backend

# Show status
echo ""
echo "✅ Setup complete!"
echo ""
pm2 list

echo ""
echo "📝 The onboarding service should now be running on port 5000"
echo "📝 Backend has been updated with ONBOARDING_SERVICE_URL and ONBOARDING_SECRET"
echo "📝 Try activating a garage number from the admin panel now"
