#!/bin/bash

echo "🔍 Checking if OAuth worked..."
echo ""

# Check EC2 logs
echo "1. Checking backend logs:"
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.230.217 "pm2 logs portal-backend --lines 100 --nostream" | grep -A5 -B2 "OAuth\|Connection created\|Page found" | tail -20

echo ""
echo "2. Checking database on EC2:"
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.230.217 << 'EOF'
cd ~/portal-backend
cat > check_connection.js << 'SCRIPT'
const { PrismaClient } = require('.prisma/client');
const prisma = new PrismaClient();

prisma.socialMediaConnection.findMany({
  where: { platform: 'facebook' },
  include: { garage: { select: { name: true } } }
}).then(connections => {
  console.log('\nFacebook Connections:');
  connections.forEach(c => {
    console.log(`  - ${c.garage.name}: Page ID ${c.pageId}, Active: ${c.isActive}`);
  });
}).catch(console.error).finally(() => prisma.$disconnect());
SCRIPT
node check_connection.js 2>/dev/null || echo "Could not check database (this is OK if OAuth hasn't happened yet)"
EOF
