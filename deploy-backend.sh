#!/bin/bash

# Exit on error
set -e

echo "Deploying backend to EC2..."

# SSH config
SSH_KEY=~/Downloads/ReceptionMatebackend.pem
EC2_HOST=ec2-user@18.171.230.217

# Build locally
echo "Building backend..."
cd backend
npm run build

# Copy files to EC2
echo "Copying files to EC2..."
rsync -avz -e "ssh -i $SSH_KEY" --exclude 'node_modules' --exclude '.git' --exclude '.env' \
  ./ $EC2_HOST:~/portal-backend/

# Restart backend on EC2
echo "Restarting backend on EC2..."
ssh -i $SSH_KEY $EC2_HOST << 'EOF'
cd ~/portal-backend
npm install --production
pm2 restart portal-backend
pm2 logs portal-backend --lines 20
EOF

echo "Backend deployment complete!"
