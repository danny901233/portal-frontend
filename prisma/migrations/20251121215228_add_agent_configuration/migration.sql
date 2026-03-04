-- CreateTable
CREATE TABLE "AgentConfiguration" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "emailAddress" TEXT,
    "branchAddress" TEXT,
    "websiteUrl" TEXT,
    "weeklyOpeningHours" TEXT,
    "holidayClosures" TEXT,
    "greetingLine" TEXT,
    "tonePreference" TEXT NOT NULL DEFAULT 'standard',
    "allowFastFitOnly" BOOLEAN NOT NULL DEFAULT false,
    "callSummaryEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentConfiguration_garageId_key" ON "AgentConfiguration"("garageId");

-- AddForeignKey
ALTER TABLE "AgentConfiguration" ADD CONSTRAINT "AgentConfiguration_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
