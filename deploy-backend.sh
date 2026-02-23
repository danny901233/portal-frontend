#!/bin/bash

# Exit on error
set -e

echo "Deploying backend to EC2..."

# SSH config
SSH_KEY=~/Downloads/ReceptionMatebackend.pem
EC2_HOST=ec2-user@18.171.230.217

# Push latest code via git (EC2 pulls from GitHub)
echo "Pushing to GitHub and deploying..."
cd ..
git push origin receptionmate-demo-branch-2

# Build and restart on EC2
ssh -i $SSH_KEY $EC2_HOST << 'EOF'
cd ~/portal-frontend
git pull origin receptionmate-demo-branch-2
cd backend
npm run build
pm2 restart backend
pm2 logs backend --lines 10 --nostream
EOF

echo "Backend deployment complete!"
