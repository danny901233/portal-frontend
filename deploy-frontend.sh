#!/bin/bash
# Deploy frontend updates to EC2
# Usage: ./deploy-frontend.sh [path-to-pem-key]
# Example: ./deploy-frontend.sh ~/Downloads/MyKey.pem

set -e

# Check if key file is provided
if [ -z "$1" ]; then
  echo "❌ Error: Please provide the path to your EC2 PEM key file"
  echo "Usage: ./deploy-frontend.sh ~/Downloads/YourKey.pem"
  exit 1
fi

KEY_FILE="$1"
EC2_HOST="ubuntu@18.171.230.217"

# Check if key file exists
if [ ! -f "$KEY_FILE" ]; then
  echo "❌ Error: Key file not found: $KEY_FILE"
  exit 1
fi

# Check key file permissions
if [ "$(stat -f %A "$KEY_FILE")" != "400" ] && [ "$(stat -f %A "$KEY_FILE")" != "600" ]; then
  echo "⚠️  Warning: Key file has incorrect permissions. Fixing..."
  chmod 400 "$KEY_FILE"
fi

echo "🚀 Deploying portal-frontend updates to EC2..."
echo "Using key: $KEY_FILE"
echo ""

# Deploy frontend
ssh -i "$KEY_FILE" "$EC2_HOST" << 'ENDSSH'
set -e

echo "📂 Navigating to portal-frontend directory..."
cd /home/ubuntu/portal-frontend

echo "📥 Pulling latest code..."
git pull origin receptionmate-demo-branch-2

echo "📦 Installing dependencies..."
npm install

echo "🏗️  Building Next.js application..."
npm run build

echo "🔄 Restarting frontend service (PM2 process 3)..."
pm2 restart 3

echo ""
echo "✅ Frontend deployment complete!"
echo ""
echo "To verify:"
echo "  pm2 logs 3 --lines 50"
ENDSSH

echo ""
echo "✨ Deployment finished successfully!"
