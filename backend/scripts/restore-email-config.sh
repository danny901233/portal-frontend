#!/bin/bash
# Restore Email Configuration to EC2 .env
# Run this when email notifications stop working after deployment

set -e

echo "================================================"
echo "Email Configuration Restore Script"
echo "================================================"
echo ""
echo "⚠️  WARNING: This will add email configuration to EC2 .env"
echo ""
echo "You will need:"
echo "  1. Mailgun API Key (or O365 credentials)"
echo "  2. Mailgun Domain"
echo "  3. From email address"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 1
fi

echo ""
echo "Enter your email provider credentials:"
echo ""

read -p "Mailgun API Key: " MAILGUN_KEY
read -p "Mailgun Domain: " MAILGUN_DOMAIN
read -p "From Email (e.g., noreply@receptionmate.co.uk): " MAILGUN_FROM

if [ -z "$MAILGUN_KEY" ] || [ -z "$MAILGUN_DOMAIN" ] || [ -z "$MAILGUN_FROM" ]; then
    echo "❌ Error: All fields are required"
    exit 1
fi

echo ""
echo "Will add to EC2 .env:"
echo "  MAILGUN_API_KEY=$MAILGUN_KEY"
echo "  MAILGUN_DOMAIN=$MAILGUN_DOMAIN"
echo "  MAILGUN_FROM=$MAILGUN_FROM"
echo ""
read -p "Proceed with EC2 update? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 1
fi

echo ""
echo "🔧 Updating EC2 .env..."

ssh ec2-user@18.171.230.217 << EOF
cd /home/ec2-user/portal-frontend/backend

# Backup existing .env
cp .env .env.backup.\$(date +%Y%m%d_%H%M%S)

# Remove old email config if exists
sed -i '/MAILGUN_API_KEY/d' .env
sed -i '/MAILGUN_DOMAIN/d' .env
sed -i '/MAILGUN_FROM/d' .env
sed -i '/O365_SMTP/d' .env
sed -i '/O365_FROM/d' .env

# Add email configuration before Database section
sed -i '/# Database/i # Email Configuration\nMAILGUN_API_KEY=$MAILGUN_KEY\nMAILGUN_DOMAIN=$MAILGUN_DOMAIN\nMAILGUN_FROM=$MAILGUN_FROM\n' .env

echo "✅ .env updated"
echo ""
echo "Restarting backend..."
pm2 restart backend

echo ""
echo "✅ Backend restarted"
echo ""
echo "Checking logs for email status..."
sleep 2
pm2 logs backend --lines 20 --nostream | grep -i "email\|mailgun" || echo "No immediate email logs"

EOF

echo ""
echo "================================================"
echo "✅ Email configuration restored!"
echo "================================================"
echo ""
echo "Next steps:"
echo "1. Check logs: ssh ec2-user@18.171.230.217 'pm2 logs backend'"
echo "2. Trigger a test call to verify emails are sent"
echo "3. Look for: 'Email sent successfully via Mailgun'"
echo ""
