#!/bin/bash
# Quick backend deployment
set -e

KEY_FILE="${1:-$HOME/.ssh/receptionmate-ec2.pem}"
EC2_HOST="ec2-user@18.171.223.223"

if [ ! -f "$KEY_FILE" ]; then
  echo "❌ Key file not found: $KEY_FILE"
  echo "Usage: ./deploy-backend-only.sh /path/to/key.pem"
  exit 1
fi

echo "🚀 Deploying backend to EC2..."

ssh -i "$KEY_FILE" "$EC2_HOST" << 'ENDSSH'
set -e
cd /home/ec2-user/portal-frontend/backend
echo "📥 Pulling latest code..."
git pull
echo "📦 Installing dependencies..."
npm install
echo "🔨 Building..."
npm run build
echo "🔄 Restarting PM2..."
pm2 restart 1
echo "✅ Deployment complete!"
pm2 logs 1 --lines 30 --nostream
ENDSSH
