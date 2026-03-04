#!/bin/bash
# One-command deployment of onboarding service fix

ssh ubuntu@18.171.223.223 << 'ENDSSH'
echo "📦 Deploying onboarding service fix..."
cd /home/ubuntu/portal-frontend

echo "⬇️  Pulling latest code..."
git pull origin receptionmate-demo-branch-2

echo "🔨 Building onboarding service..."
cd onboarding-service
npm run build

echo "🔄 Restarting service..."
pm2 restart onboarding-service

echo "✅ Deployment complete!"
echo ""
echo "📊 Service status:"
pm2 list | grep onboarding

echo ""
echo "📋 Recent logs:"
pm2 logs onboarding-service --lines 5 --nostream

echo ""
echo "✅ All done! You can now create a test account."
ENDSSH
