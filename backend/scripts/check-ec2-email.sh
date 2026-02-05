#!/bin/bash

# EC2 Email Configuration Checker
# Run this from your local machine to diagnose email issues on EC2

EC2_HOST="ec2-user@18.171.230.217"
EC2_PATH="/home/ec2-user/portal-frontend/backend"

echo "================================================"
echo "EC2 Email Notification Diagnostic"
echo "================================================"
echo ""

echo "Connecting to EC2: $EC2_HOST"
echo ""

ssh $EC2_HOST << 'ENDSSH'
cd /home/ec2-user/portal-frontend/backend

echo "=== 1. CHECKING ENVIRONMENT VARIABLES ==="
echo ""

if [ -f .env ]; then
    echo "✓ .env file exists"
    echo ""
    echo "Email configuration status:"

    if grep -q "MAILGUN_API_KEY" .env; then
        echo "  ✓ MAILGUN_API_KEY found"
    else
        echo "  ✗ MAILGUN_API_KEY missing"
    fi

    if grep -q "MAILGUN_DOMAIN" .env; then
        echo "  ✓ MAILGUN_DOMAIN found"
    else
        echo "  ✗ MAILGUN_DOMAIN missing"
    fi

    if grep -q "MAILGUN_FROM" .env; then
        echo "  ✓ MAILGUN_FROM found"
    else
        echo "  ✗ MAILGUN_FROM missing"
    fi

    if grep -q "O365_SMTP_USER" .env; then
        echo "  ✓ O365_SMTP_USER found"
    else
        echo "  ✗ O365_SMTP_USER missing"
    fi

    if grep -q "O365_SMTP_PASS" .env; then
        echo "  ✓ O365_SMTP_PASS found"
    else
        echo "  ✗ O365_SMTP_PASS missing"
    fi

    echo ""
    echo "Full email-related .env variables:"
    grep -E "MAILGUN|O365" .env 2>/dev/null || echo "  (none found)"
else
    echo "✗ .env file NOT FOUND at $PWD/.env"
fi

echo ""
echo "=== 2. CHECKING PM2 STATUS ==="
echo ""
pm2 list

echo ""
echo "=== 3. RECENT PM2 LOGS (Email-related) ==="
echo ""
pm2 logs backend --lines 500 --nostream 2>/dev/null | grep -i -E "email|mailgun|o365|notification" | tail -20 || echo "No email-related logs found"

echo ""
echo "=== 4. DATABASE CONFIGURATION ==="
echo ""

# Get DATABASE_URL
if [ -f .env ]; then
    export $(grep -v '^#' .env | grep DATABASE_URL | xargs)
fi

if [ -z "$DATABASE_URL" ]; then
    echo "✗ DATABASE_URL not found in .env"
else
    echo "✓ DATABASE_URL found, checking database..."
    echo ""

    psql "$DATABASE_URL" -t -c "
        SELECT
            g.id,
            g.name,
            ac.\"branchName\",
            ac.\"notificationEmails\"::text as emails,
            array_length(ac.\"notificationEmails\", 1) as email_count
        FROM \"Garage\" g
        LEFT JOIN \"AgentConfiguration\" ac ON g.id = ac.\"garageId\"
        ORDER BY g.name;
    " 2>/dev/null || echo "Failed to query database"

    echo ""
    echo "Recent call activity:"
    psql "$DATABASE_URL" -t -c "
        SELECT
            g.name as garage,
            COUNT(*) as calls_today
        FROM \"Call\" c
        JOIN \"Garage\" g ON c.\"garageId\" = g.id
        WHERE c.\"createdAt\" > NOW() - INTERVAL '24 hours'
        GROUP BY g.name
        ORDER BY calls_today DESC;
    " 2>/dev/null || echo "Failed to query call data"
fi

echo ""
echo "================================================"
echo "DIAGNOSTIC COMPLETE"
echo "================================================"
echo ""
echo "Next steps:"
echo "1. If email credentials are missing, add them to .env"
echo "2. If notification emails are empty, update database"
echo "3. Restart PM2: pm2 restart backend"
echo "4. Check logs: pm2 logs backend"
echo ""

ENDSSH

echo ""
echo "To fix issues, SSH into EC2:"
echo "  ssh $EC2_HOST"
echo ""
echo "Then refer to: backend/scripts/ec2-debug-guide.md"
