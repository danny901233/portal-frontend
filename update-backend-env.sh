#!/bin/bash
# Update backend .env on EC2 to add LIVEKIT_SIP_DOMAIN

echo "Adding LIVEKIT_SIP_DOMAIN to backend .env on EC2..."

ssh ubuntu@18.171.223.223 << 'EOF'
cd /home/ubuntu/portal-frontend/backend

# Check if LIVEKIT_SIP_DOMAIN already exists
if grep -q "LIVEKIT_SIP_DOMAIN" .env; then
  echo "LIVEKIT_SIP_DOMAIN already exists in .env"
else
  # Add LIVEKIT_SIP_DOMAIN before the Database section
  sed -i '/# Database/i # LiveKit Configuration\nLIVEKIT_SIP_DOMAIN=n4s20ufg0v7.sip.livekit.cloud\n' .env
  echo "✅ Added LIVEKIT_SIP_DOMAIN to .env"
fi

# Show the updated .env
echo "Current backend .env:"
cat .env

# Restart backend
echo "Restarting backend..."
pm2 restart backend

echo "✅ Backend updated and restarted"
EOF
