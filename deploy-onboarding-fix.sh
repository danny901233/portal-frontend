#!/bin/bash
# Deploy onboarding service fix to EC2

echo "Deploying onboarding service fix..."

# Build locally first
cd onboarding-service
npm run build

# Create tarball
tar -czf ../onboarding-fix.tar.gz -C . dist node_modules package.json

cd ..

# Upload and deploy
scp onboarding-fix.tar.gz ubuntu@18.171.223.223:/home/ubuntu/

ssh ubuntu@18.171.223.223 << 'EOF'
cd /home/ubuntu/portal-frontend/onboarding-service

# Backup current
cp src/server.ts src/server.ts.backup

# Extract new files
cd /home/ubuntu
tar -xzf onboarding-fix.tar.gz -C portal-frontend/onboarding-service/

# Restart service
pm2 restart onboarding-service

# Check status
pm2 logs onboarding-service --lines 10

echo "✅ Onboarding service updated"
EOF

rm onboarding-fix.tar.gz
