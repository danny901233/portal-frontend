-- Delete all existing Facebook connections
DELETE FROM "SocialMediaConnection" WHERE platform = 'facebook';

-- Create new Facebook connection in correct garage
INSERT INTO "SocialMediaConnection" (
  id,
  "garageId",
  platform,
  "pageId",
  "accessToken",
  "isActive",
  "createdAt",
  "updatedAt"
) VALUES (
  gen_random_uuid(),
  'd51dfa55-15d0-4d60-ad81-c675579d16f6',
  'facebook',
  '224576834077659',
  'EAAWvZApHZBPUwBQjJTmTJ25OYfKab5xQMI1Bt6EntSYPtRqBET2HG5CB0KHONmmrbyOgAClLVi9shkGhKn0BcRZCiAyVasbfhpTZA4IShK3pZAJDJiUJDbfhMy2MsX40rIycYpqa3I1WzKOuT5TjyqTy0DBAESZACuw65pTqpbvwtZB0m7pjDJ5NsuVg6jNkMZBkfW9p',
  true,
  NOW(),
  NOW()
);

-- Verify creation
SELECT
  id,
  "garageId",
  platform,
  "pageId",
  "isActive",
  "createdAt"
FROM "SocialMediaConnection"
WHERE platform = 'facebook';
