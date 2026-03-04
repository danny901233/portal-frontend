-- Add Twilio tracking fields to Call
ALTER TABLE "Call" ADD COLUMN "recordingDurationSeconds" INTEGER;
ALTER TABLE "Call" ADD COLUMN "recordingCompletedAt" TIMESTAMP(3);
ALTER TABLE "Call" ADD COLUMN "twilioCallSid" TEXT;

-- Create TwilioRecording table
CREATE TABLE "TwilioRecording" (
  "id" TEXT NOT NULL,
  "callSid" TEXT NOT NULL,
  "recordingSid" TEXT,
  "recordingUrl" TEXT NOT NULL,
  "recordingDurationSeconds" INTEGER,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TwilioRecording_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TwilioRecording_callSid_key" ON "TwilioRecording"("callSid");
