#!/bin/bash
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.223.223 << 'REMOTESCRIPT'
export DATABASE_URL="postgresql://daniel:BpJHzsb3Vq3HHcBfMbzC@localhost:5432/receptionmate"
psql $DATABASE_URL << 'SQL'
INSERT INTO "SocialMediaConnection" (id, "garageId", platform, "pageId", "accessToken", "isActive", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid(),
  'd51dfa55-15d0-4d60-ad81-c675579d16f6',
  'facebook',
  '224576834077659',
  'EAAWvZApHZBPUwBQp22ZCQOsSZBKJohLHeILJDZAYOCsjUZAOHOpyelgSQIrxyi3oO6ZCTHUgOXZAv8b2lMqqBCsrW875ncyJ1z9lbIqJlf6Y5EwwYahSBucB43yOCCdAZCOgX4cOYUsiEBykSZCtc1OZA9FkUquv7a2mNjXQC88ZBVLIs3KR4EgwS6NNQPWh4rulpgOVTngTHxRS9eRnJxx6wHM91srNwEmyN4ZBgYR5kr0FfxgZDZD',
  true,
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

SELECT id, platform, "pageId", "isActive" FROM "SocialMediaConnection" WHERE platform = 'facebook';
SQL
REMOTESCRIPT
