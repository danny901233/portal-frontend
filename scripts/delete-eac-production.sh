#!/bin/bash

# Delete EAC TELFORD HALESFIELD call logs on production
# Run this script on the EC2 production server

echo "🚀 Connecting to production EC2 and deleting EAC TELFORD HALESFIELD calls..."
echo ""

ssh -i ~/.ssh/your-key.pem ec2-user@18.171.223.223 << 'ENDSSH'
  cd /home/ec2-user/portal-frontend
  
  # Make sure we're using the production database
  echo "📊 Current database connection:"
  grep DATABASE_URL .env | head -1
  echo ""
  
  # Run the delete script
  npx tsx scripts/delete-garage-calls.ts "EAC TELFORD HALESFIELD"
ENDSSH

echo ""
echo "✅ Done!"
