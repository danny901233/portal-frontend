#!/bin/bash

# Test script to send feature announcement email to dan@receptionmate.co.uk

echo "Sending feature announcement test email..."

curl -X POST http://localhost:4000/api/send-feature-announcement \
  -H "Content-Type: application/json" \
  -d '{
    "testEmail": "dan@receptionmate.co.uk"
  }'

echo ""
echo "Done! Check dan@receptionmate.co.uk for the email."
