-- CreateTable
CREATE TABLE "ChatConversation" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "customerPhone" TEXT,
    "customerId" TEXT,
    "customerName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialMediaConnection" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "whatsappPhoneNumberId" TEXT,
    "pageId" TEXT,
    "instagramAccountId" TEXT,
    "accessToken" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialMediaConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatConversation_garageId_status_idx" ON "ChatConversation"("garageId", "status");

-- CreateIndex
CREATE INDEX "ChatConversation_garageId_platform_idx" ON "ChatConversation"("garageId", "platform");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialMediaConnection_garageId_platform_key" ON "SocialMediaConnection"("garageId", "platform");

-- CreateIndex
CREATE INDEX "SocialMediaConnection_garageId_idx" ON "SocialMediaConnection"("garageId");

-- AddForeignKey
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialMediaConnection" ADD CONSTRAINT "SocialMediaConnection_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
