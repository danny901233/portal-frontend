#!/bin/bash
set -e

echo "🚀 Deploying onboarding service to EC2..."

# Deploy to EC2
ssh -i ~/Downloads/ReceptionMate.pem ec2-user@ec2-18-171-230-217.eu-west-2.compute.amazonaws.com << 'ENDSSH'
  cd /home/ec2-user/portal-frontend
  
  echo "📥 Pulling latest code..."
  git pull origin receptionmate-demo-branch-2
  
  echo "📦 Installing onboarding service dependencies..."
  cd onboarding-service
  npm install
  
  echo "🔨 Building onboarding service..."
  npm run build
  
  echo "🔧 Updating backend .env with onboarding service URL..."
  cd ../backend
  
  # Add or update ONBOARDING_SERVICE_URL
  if grep -q "ONBOARDING_SERVICE_URL" .env; then
    sed -i 's|ONBOARDING_SERVICE_URL=.*|ONBOARDING_SERVICE_URL=http://localhost:5000/provision|' .env
  else
    echo "ONBOARDING_SERVICE_URL=http://localhost:5000/provision" >> .env
  fi
  
  # Add or update ONBOARDING_SECRET
  if grep -q "ONBOARDING_SECRET" .env; then
    sed -i 's|ONBOARDING_SECRET=.*|ONBOARDING_SECRET=ob-secret-7h9k2m4p6q8r1s3t5v|' .env
  else
    echo "ONBOARDING_SECRET=ob-secret-7h9k2m4p6q8r1s3t5v" >> .env
  fi
  
  echo "🔄 Restarting services with PM2..."
  cd ..
  
  # Stop onboarding service if it exists
  pm2 delete onboarding-service 2>/dev/null || true
  
  # Start onboarding service
  cd onboarding-service
  pm2 start npm --name "onboarding-service" -- start
  
  # Restart backend to pick up new env vars
  pm2 restart backend
  
  echo "✅ Deployment complete!"
  pm2 list
ENDSSH

echo "✅ Onboarding service deployed and running on EC2!"
