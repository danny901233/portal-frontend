#!/bin/bash

# Check if backend is running
echo "Checking backend health..."
curl -s http://localhost:3001/health 2>/dev/null || echo "Backend not responding"

echo -e "\n\nChecking messaging-access endpoint with test garage ID..."
# Using one of the valid garage IDs from the database
GARAGE_ID="827efd7f-c5df-47b1-b2b0-f9a5bde39efa"
curl -s "http://localhost:3001/api/garages/${GARAGE_ID}/messaging-access" \
  -H "Authorization: Bearer test" 2>/dev/null || echo "Endpoint not responding"
