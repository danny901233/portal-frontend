#!/bin/bash
# Simple deployment commands for EC2
# Copy these commands and run them in your EC2 SSH session

cd portal-frontend
git pull origin receptionmate-demo-branch-2
cd onboarding-service
npm install
npm run build
cd ..

# Update backend .env
cat >> backend/.env << 'EOF'

# Onboarding Service Configuration
ONBOARDING_SERVICE_URL=http://localhost:5000/provision
ONBOARDING_SECRET=ob-secret-7h9k2m4p6q8r1s3t5v
EOF

# Start onboarding service
cd onboarding-service
pm2 delete onboarding-service 2>/dev/null || true
pm2 start npm --name "onboarding-service" -- start
pm2 restart backend
pm2 list
