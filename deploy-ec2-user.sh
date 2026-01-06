#!/bin/bash
# Deploy portal to EC2 (ec2-user directory)
set -e

echo "🚀 Deploying portal updates..."

# Find the portal directory
if [ -d "/home/ec2-user/portal-frontend" ]; then
  PORTAL_DIR="/home/ec2-user/portal-frontend"
elif [ -d "/home/ubuntu/portal-frontend" ]; then
  PORTAL_DIR="/home/ubuntu/portal-frontend"
else
  echo "❌ Portal directory not found"
  exit 1
fi

echo "📂 Found portal at: $PORTAL_DIR"
cd $PORTAL_DIR

# Pull latest changes
echo "📥 Pulling latest code..."
git pull origin receptionmate-demo-branch-2

# Backend deployment
echo "🔧 Deploying backend..."
cd backend
npm install
npx prisma generate --schema=../prisma/schema.prisma
pm2 restart backend || pm2 start npm --name backend -- start

# Frontend deployment
echo "🎨 Deploying frontend..."
cd ..
npm install
npm run build
pm2 restart frontend || pm2 start npm --name frontend -- start

echo "✅ Deployment complete!"
