#!/bin/bash
# Deploy backend updates to EC2
# Run this on the EC2 server: ubuntu@18.171.230.217

set -e

echo "🚀 Deploying portal-frontend updates..."

# Navigate to backend directory
cd /home/ubuntu/portal-frontend/backend

# Pull latest changes
echo "📥 Pulling latest code..."
git pull origin receptionmate-demo-branch-2

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Generate Prisma client
echo "🔧 Generating Prisma client..."
npx prisma generate --schema=../prisma/schema.prisma

# Run database migrations
echo "🗄️  Running database migrations..."
npx prisma migrate deploy --schema=../prisma/schema.prisma

# Restart backend service
echo "🔄 Restarting backend service..."
pm2 restart backend

echo "✅ Deployment complete!"
echo ""
echo "To verify:"
echo "  pm2 logs backend --lines 50"
