CREATE TABLE IF NOT EXISTS "PendingSignup" (
  "id" TEXT NOT NULL,
  "businessName" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "googlePlaceId" TEXT,
  "branchAddress" TEXT,
  "phoneNumber" TEXT,
  "websiteUrl" TEXT,
  "weeklyOpeningHours" JSONB,
  "signToken" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "ghlOpportunityId" TEXT,
  "ghlContactId" TEXT,
  "signedByName" TEXT,
  "signedByPosition" TEXT,
  "signatureImage" TEXT,
  "signedFromIp" TEXT,
  "signedUserAgent" TEXT,
  "templateSnapshot" TEXT,
  "agreementVersion" TEXT,
  "signedAt" TIMESTAMP(3),
  "stripeCustomerId" TEXT,
  "stripeSubscriptionId" TEXT,
  "trialEndsAt" TIMESTAMP(3),
  "createdGarageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PendingSignup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PendingSignup_signToken_key" ON "PendingSignup"("signToken");
CREATE INDEX IF NOT EXISTS "PendingSignup_email_idx" ON "PendingSignup"("email");
CREATE INDEX IF NOT EXISTS "PendingSignup_stripeCustomerId_idx" ON "PendingSignup"("stripeCustomerId");
