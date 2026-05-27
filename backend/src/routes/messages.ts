import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import multer from 'multer';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
});

// GET /api/garages/:garageId/messaging-access - Check if garage has messaging access
router.get(
  '/garages/:garageId/messaging-access',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;
      console.log(`[MESSAGING ACCESS] Checking for garage: ${garageId}`);

      const garage = await prisma.garage.findUnique({
        where: { id: garageId },
        select: { id: true, name: true, hasMessagingAccess: true },
      });

      if (!garage) {
        console.log(`[MESSAGING ACCESS] Garage not found: ${garageId}`);
        return res.status(404).json({ error: 'Garage not found' });
      }

      console.log(`[MESSAGING ACCESS] Garage: ${garage.name}, hasMessagingAccess: ${garage.hasMessagingAccess}`);

      res.json({
        success: true,
        hasMessagingAccess: garage.hasMessagingAccess,
      });
    } catch (error) {
      console.error('Failed to check messaging access:', error);
      res.status(500).json({ error: 'Failed to check messaging access' });
    }
  }
);

// GET /api/garages/:garageId/messages/needs-attention-count - Get count of messages needing attention
router.get(
  '/garages/:garageId/messages/needs-attention-count',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;

      // Check messaging access
      const garage = await prisma.garage.findUnique({
        where: { id: garageId },
        select: { hasMessagingAccess: true },
      });

      if (!garage?.hasMessagingAccess) {
        return res.json({ success: true, count: 0 });
      }

      const count = await prisma.chatConversation.count({
        where: {
          garageId,
          status: 'active',
          needsAttention: true,
        },
      });

      res.json({ success: true, count });
    } catch (error) {
      console.error('Failed to fetch needs attention count:', error);
      res.status(500).json({ error: 'Failed to fetch needs attention count' });
    }
  }
);

// GET /api/garages/:garageId/message-stats - Get message statistics
router.get(
  '/garages/:garageId/message-stats',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;
      const { startDate, endDate } = req.query;

      // Check messaging access
      const garage = await prisma.garage.findUnique({
        where: { id: garageId },
        select: { hasMessagingAccess: true },
      });

      if (!garage?.hasMessagingAccess) {
        return res.status(403).json({ error: 'Messaging access not enabled' });
      }

      const platforms = ['whatsapp', 'facebook', 'instagram'];
      const stats: any = {};

      // Build date filter
      const dateFilter: any = {};
      if (startDate && typeof startDate === 'string') {
        dateFilter.gte = new Date(startDate);
      }
      if (endDate && typeof endDate === 'string') {
        dateFilter.lte = new Date(endDate);
      }

      for (const platform of platforms) {
        const baseWhere: any = { garageId, platform };
        if (Object.keys(dateFilter).length > 0) {
          baseWhere.createdAt = dateFilter;
        }

        const active = await prisma.chatConversation.count({
          where: { ...baseWhere, status: 'active', needsAttention: false },
        });

        const needsAttention = await prisma.chatConversation.count({
          where: { ...baseWhere, status: 'active', needsAttention: true },
        });

        const resolved = await prisma.chatConversation.count({
          where: { ...baseWhere, status: 'resolved' },
        });

        const totalConversations = await prisma.chatConversation.count({
          where: baseWhere,
        });

        stats[platform] = {
          active,
          needsAttention,
          resolved,
          total: totalConversations,
        };
      }

      // Calculate totals
      stats.totals = {
        active: Object.values(stats).reduce((sum: number, s: any) => sum + (s.active || 0), 0),
        needsAttention: Object.values(stats).reduce((sum: number, s: any) => sum + (s.needsAttention || 0), 0),
        resolved: Object.values(stats).reduce((sum: number, s: any) => sum + (s.resolved || 0), 0),
        total: Object.values(stats).reduce((sum: number, s: any) => sum + (s.total || 0), 0),
      };

      res.json({ success: true, stats });
    } catch (error) {
      console.error('Failed to fetch message stats:', error);
      res.status(500).json({ error: 'Failed to fetch message stats' });
    }
  }
);

// GET /api/garages/:garageId/message-stats/csv - Download message statistics as CSV
router.get(
  '/garages/:garageId/message-stats/csv',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;
      const { startDate, endDate } = req.query;

      // Check messaging access
      const garage = await prisma.garage.findUnique({
        where: { id: garageId },
        select: { hasMessagingAccess: true, name: true },
      });

      if (!garage?.hasMessagingAccess) {
        return res.status(403).json({ error: 'Messaging access not enabled' });
      }

      // Build date filter
      const dateFilter: any = {};
      if (startDate && typeof startDate === 'string') {
        dateFilter.gte = new Date(startDate);
      }
      if (endDate && typeof endDate === 'string') {
        dateFilter.lte = new Date(endDate);
      }

      const baseWhere: any = { garageId };
      if (Object.keys(dateFilter).length > 0) {
        baseWhere.createdAt = dateFilter;
      }

      // Fetch all conversations in the date range
      const conversations = await prisma.chatConversation.findMany({
        where: baseWhere,
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
            take: 1, // Just get the first message for context
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      // Build CSV
      const csvRows = [
        [
          'Conversation ID',
          'Platform',
          'Customer Name',
          'Customer Phone',
          'Status',
          'Needs Attention',
          'Agent Paused',
          'Message Type',
          'Confirmed Booking',
          'Booking Category',
          'Captured Revenue',
          'Tags',
          'Created At',
          'Last Message At',
          'First Message',
        ].join(','),
      ];

      for (const conv of conversations) {
        const firstMessage = conv.messages[0]?.content || '';
        const tags = Array.isArray(conv.tags) ? conv.tags.join('; ') : '';

        csvRows.push([
          conv.id,
          conv.platform,
          conv.customerName || '',
          conv.customerPhone || '',
          conv.status,
          conv.needsAttention ? 'Yes' : 'No',
          conv.agentPaused ? 'Yes' : 'No',
          conv.messageType || '',
          conv.confirmedBooking ? 'Yes' : 'No',
          conv.confirmedBookingCategory || '',
          conv.capturedRevenue?.toString() || '',
          tags,
          new Date(conv.createdAt).toISOString(),
          new Date(conv.lastMessageAt).toISOString(),
          `"${firstMessage.replace(/"/g, '""').substring(0, 100)}"`,
        ].join(','));
      }

      const csv = csvRows.join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="message-stats-${garageId}.csv"`);
      res.send(csv);
    } catch (error) {
      console.error('Failed to generate CSV:', error);
      res.status(500).json({ error: 'Failed to generate CSV' });
    }
  }
);

// Middleware to check if garage has messaging access
async function requireMessagingAccess(req: Request, res: Response, next: Function) {
  try {
    const garageId = req.params.garageId || req.body.garageId;

    if (!garageId) {
      return res.status(400).json({ error: 'Garage ID required' });
    }

    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: { hasMessagingAccess: true },
    });

    if (!garage) {
      return res.status(404).json({ error: 'Garage not found' });
    }

    if (!garage.hasMessagingAccess) {
      return res.status(403).json({
        error: 'Messaging access not enabled',
        message: 'This garage does not have messaging subscription. Please contact admin to enable it.',
      });
    }

    next();
  } catch (error) {
    console.error('Messaging access check failed:', error);
    res.status(500).json({ error: 'Failed to verify messaging access' });
  }
}

// GET /api/garages/:garageId/conversations - List conversations with filters
router.get(
  '/garages/:garageId/conversations',
  authenticate,
  requireMessagingAccess,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;
      const { platform, status } = req.query;

      const where: any = { garageId };

      if (platform && platform !== 'all') {
        where.platform = platform;
      }

      if (status && status !== 'all') {
        where.status = status;
      }

      const allConversations = await prisma.chatConversation.findMany({
        where,
        include: {
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          customer: true,
        },
        orderBy: { lastMessageAt: 'desc' },
      });

      // Group conversations by customer
      const groupedByCustomer = new Map<string, any[]>();
      const withoutCustomer: any[] = [];

      for (const conv of allConversations) {
        if (conv.customerId) {
          const existing = groupedByCustomer.get(conv.customerId) || [];
          existing.push(conv);
          groupedByCustomer.set(conv.customerId, existing);
        } else {
          withoutCustomer.push(conv);
        }
      }

      // Merge conversations with same customer
      const mergedConversations = [];

      for (const [customerId, convs] of groupedByCustomer.entries()) {
        if (convs.length === 1) {
          mergedConversations.push(convs[0]);
        } else {
          // Merge multiple conversations into one
          const platforms = convs.map(c => c.platform);
          const allMessages = convs.flatMap(c => c.messages);
          const latestMessage = allMessages.sort((a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          )[0];

          const totalUnread = convs.reduce((sum, c) => sum + c.unreadCount, 0);
          const latestConv = convs.sort((a, b) =>
            new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
          )[0];

          mergedConversations.push({
            id: latestConv.id,
            garageId: latestConv.garageId,
            platform: platforms.join(','), // "whatsapp,facebook,instagram"
            platforms: platforms, // Array of platforms
            customerPhone: latestConv.customerPhone,
            customerId: customerId,
            customer: latestConv.customer,
            customerName: latestConv.customer?.name || latestConv.customerName,
            status: latestConv.status,
            unreadCount: totalUnread,
            lastMessageAt: latestConv.lastMessageAt,
            messages: [latestMessage],
            conversationIds: convs.map(c => c.id), // Store all conversation IDs
          });
        }
      }

      // Add conversations without customer
      mergedConversations.push(...withoutCustomer);

      // Sort by last message time
      mergedConversations.sort((a, b) =>
        new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
      );

      res.json({ success: true, conversations: mergedConversations });
    } catch (error) {
      console.error('Failed to fetch conversations:', error);
      res.status(500).json({ error: 'Failed to fetch conversations' });
    }
  }
);

// GET /api/conversations/:conversationId - Get single conversation with messages
router.get(
  '/conversations/:conversationId',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { conversationId } = req.params;

      const conversation = await prisma.chatConversation.findUnique({
        where: { id: conversationId },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
          },
          customer: true,
          garage: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // If this conversation has a customer, fetch ALL conversations with same customer
      let allMessages = conversation.messages;
      let allConversations = [conversation];

      if (conversation.customerId) {
        const relatedConversations = await prisma.chatConversation.findMany({
          where: {
            garageId: conversation.garageId,
            customerId: conversation.customerId,
          },
          include: {
            messages: {
              orderBy: { createdAt: 'asc' },
            },
            customer: true,
            garage: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        });

        allConversations = relatedConversations;

        // Merge all messages from all platforms, sorted by time
        allMessages = relatedConversations
          .flatMap(conv => conv.messages.map(msg => ({
            ...msg,
            platform: conv.platform, // Add platform to each message
          })))
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

        // Mark all as read
        for (const conv of relatedConversations) {
          if (conv.unreadCount > 0) {
            await prisma.chatConversation.update({
              where: { id: conv.id },
              data: { unreadCount: 0 },
            });
          }
        }
      } else {
        // Mark as read
        if (conversation.unreadCount > 0) {
          await prisma.chatConversation.update({
            where: { id: conversationId },
            data: { unreadCount: 0 },
          });
        }
      }

      // Check if conversation is within 24-hour messaging window
      const withinMessagingWindow = isWithinMessagingWindow(conversation.lastMessageAt);

      // Auto-resolve if past 24-hour window and still active
      if (!withinMessagingWindow && conversation.status === 'active') {
        await prisma.chatConversation.update({
          where: { id: conversationId },
          data: { status: 'resolved' },
        });
        console.log(`Auto-resolved conversation ${conversationId} - past 24-hour messaging window`);
      }

      res.json({
        success: true,
        conversation: {
          ...conversation,
          messages: allMessages,
          platforms: allConversations.map(c => c.platform),
          conversationIds: allConversations.map(c => c.id),
          withinMessagingWindow,
        },
      });
    } catch (error) {
      console.error('Failed to fetch conversation:', error);
      res.status(500).json({ error: 'Failed to fetch conversation' });
    }
  }
);

// POST /api/conversations/:conversationId/messages - Send manual message
router.post(
  '/conversations/:conversationId/messages',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { conversationId } = req.params;

      const schema = z.object({
        content: z.string().min(1),
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Invalid request', details: result.error.flatten() });
      }

      const { content } = result.data;

      // Get conversation
      const conversation = await prisma.chatConversation.findUnique({
        where: { id: conversationId },
        include: {
          garage: {
            include: {
              socialMediaConnections: {
                where: { platform: { in: ['whatsapp', 'facebook', 'instagram'] }, isActive: true },
              },
            },
          },
        },
      });

      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // Save message to DB
      const message = await prisma.chatMessage.create({
        data: {
          conversationId,
          role: 'assistant',
          content,
        },
      });

      // Update conversation and pause agent for 24 hours when garage joins
      await prisma.chatConversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: new Date(),
          agentPaused: true, // Pause agent when garage sends manual message
          agentPausedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
        },
      });

      // Send message via appropriate platform
      const connection = conversation.garage.socialMediaConnections.find(
        (c) => c.platform === conversation.platform
      );

      if (connection) {
        await sendMessage(conversation, content, connection);
      }

      res.json({ success: true, message });
    } catch (error) {
      console.error('Failed to send message:', error);
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
);

// POST /api/conversations/:conversationId/messages/image - Send image message
router.post(
  '/conversations/:conversationId/messages/image',
  authenticate,
  upload.single('image'),
  async (req: Request, res: Response) => {
    try {
      const { conversationId } = req.params;
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) {
        return res.status(400).json({ error: 'No image file provided' });
      }

      const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowedTypes.includes(file.mimetype)) {
        return res.status(400).json({ error: 'Unsupported image type. Use JPEG, PNG, or WebP.' });
      }

      const conversation = await prisma.chatConversation.findUnique({
        where: { id: conversationId },
        include: {
          garage: {
            include: {
              socialMediaConnections: {
                where: { platform: { in: ['whatsapp', 'facebook', 'instagram'] }, isActive: true },
              },
            },
          },
        },
      });

      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // Upload to S3
      const awsAccessKey = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
      const awsSecretKey = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
      const awsRegion = process.env.S3_REGION || process.env.AWS_REGION || 'eu-west-2';
      const s3Bucket = process.env.S3_MEDIA_BUCKET || process.env.S3_BUCKET || 'receptionmate-recordings';

      if (!awsAccessKey || !awsSecretKey) {
        return res.status(500).json({ error: 'S3 not configured' });
      }

      const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
      const s3Key = `chat-media/${conversation.garageId}/${conversationId}/${randomUUID()}.${ext}`;

      const s3 = new S3Client({
        region: awsRegion,
        credentials: { accessKeyId: awsAccessKey, secretAccessKey: awsSecretKey },
      });

      await s3.send(new PutObjectCommand({
        Bucket: s3Bucket,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }));

      const mediaUrl = `https://${s3Bucket}.s3.${awsRegion}.amazonaws.com/${s3Key}`;
      const caption = (req.body.caption || '').trim();

      // Save message to DB
      const message = await prisma.chatMessage.create({
        data: {
          conversationId,
          role: 'assistant',
          content: caption || '[Image]',
          mediaUrl,
          mediaType: file.mimetype,
        },
      });

      // Update conversation and pause agent
      await prisma.chatConversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: new Date(),
          agentPaused: true,
          agentPausedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      // Send via WhatsApp
      const connection = conversation.garage.socialMediaConnections.find(
        (c) => c.platform === conversation.platform
      );

      if (connection) {
        await sendImageMessage(conversation, mediaUrl, caption, connection);
      }

      res.json({ success: true, message });
    } catch (error) {
      console.error('Failed to send image message:', error);
      res.status(500).json({ error: 'Failed to send image message' });
    }
  }
);

// PATCH /api/conversations/:conversationId - Update conversation status
router.patch(
  '/conversations/:conversationId',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { conversationId } = req.params;

      const schema = z.object({
        status: z.enum(['active', 'resolved', 'archived']).optional(),
        unreadCount: z.number().optional(),
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Invalid request', details: result.error.flatten() });
      }

      const conversation = await prisma.chatConversation.update({
        where: { id: conversationId },
        data: result.data,
      });

      res.json({ success: true, conversation });
    } catch (error) {
      console.error('Failed to update conversation:', error);
      res.status(500).json({ error: 'Failed to update conversation' });
    }
  }
);

// PATCH /api/conversations/:conversationId/tags - Update conversation tags
router.patch(
  '/conversations/:conversationId/tags',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { conversationId } = req.params;

      const schema = z.object({
        messageType: z.string().optional(),
        confirmedBooking: z.boolean().optional(),
        confirmedBookingCategory: z.enum(['service', 'diagnostic', 'mot', 'other']).optional().nullable(),
        capturedRevenue: z.number().optional().nullable(),
        bookingDetails: z.string().optional(),
        tags: z.array(z.string()).optional(),
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Invalid request', details: result.error.flatten() });
      }

      const conversation = await prisma.chatConversation.update({
        where: { id: conversationId },
        data: {
          messageType: result.data.messageType,
          confirmedBooking: result.data.confirmedBooking,
          confirmedBookingCategory: result.data.confirmedBookingCategory,
          capturedRevenue: result.data.capturedRevenue,
          bookingDetails: result.data.bookingDetails,
          tags: result.data.tags,
        },
      });

      res.json({ success: true, conversation });
    } catch (error) {
      console.error('Failed to update conversation tags:', error);
      res.status(500).json({ error: 'Failed to update conversation tags' });
    }
  }
);

// PATCH /api/conversations/:conversationId/agent - Toggle agent pause/resume
router.patch(
  '/conversations/:conversationId/agent',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { conversationId } = req.params;

      const schema = z.object({
        agentPaused: z.boolean(),
        pauseDurationHours: z.number().optional(), // 2, 4, 8, or 24
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Invalid request', details: result.error.flatten() });
      }

      // Update all related conversations if this is part of a merged customer conversation
      const conversation = await prisma.chatConversation.findUnique({
        where: { id: conversationId },
      });

      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // Calculate pause expiry time if pausing
      let agentPausedUntil = null;
      if (result.data.agentPaused && result.data.pauseDurationHours) {
        agentPausedUntil = new Date(Date.now() + result.data.pauseDurationHours * 60 * 60 * 1000);
      }

      const updateData: any = {
        agentPaused: result.data.agentPaused,
        agentPausedUntil,
      };

      // Update all conversations for this customer
      if (conversation.customerId) {
        await prisma.chatConversation.updateMany({
          where: {
            garageId: conversation.garageId,
            customerId: conversation.customerId,
          },
          data: updateData,
        });
      } else {
        // Update just this conversation
        await prisma.chatConversation.update({
          where: { id: conversationId },
          data: updateData,
        });
      }

      res.json({
        success: true,
        agentPaused: result.data.agentPaused,
        agentPausedUntil,
      });
    } catch (error) {
      console.error('Failed to update agent status:', error);
      res.status(500).json({ error: 'Failed to update agent status' });
    }
  }
);

// PATCH /api/conversations/:conversationId/flag - Toggle needs attention flag
router.patch(
  '/conversations/:conversationId/flag',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { conversationId } = req.params;

      const schema = z.object({
        needsAttention: z.boolean(),
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Invalid request', details: result.error.flatten() });
      }

      // Update all related conversations if this is part of a merged customer conversation
      const conversation = await prisma.chatConversation.findUnique({
        where: { id: conversationId },
      });

      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // When flagging for attention, automatically pause the agent for 24 hours
      const updateData: any = { needsAttention: result.data.needsAttention };
      if (result.data.needsAttention) {
        updateData.agentPaused = true;
        updateData.agentPausedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
      } else {
        // When unflagging, don't automatically resume - let user control that
        updateData.agentPausedUntil = null;
      }

      // Update all conversations for this customer
      if (conversation.customerId) {
        await prisma.chatConversation.updateMany({
          where: {
            garageId: conversation.garageId,
            customerId: conversation.customerId,
          },
          data: updateData,
        });
      } else {
        // Update just this conversation
        await prisma.chatConversation.update({
          where: { id: conversationId },
          data: updateData,
        });
      }

      res.json({ success: true, needsAttention: result.data.needsAttention, agentPaused: updateData.agentPaused });
    } catch (error) {
      console.error('Failed to update needs attention flag:', error);
      res.status(500).json({ error: 'Failed to update needs attention flag' });
    }
  }
);

// Helper function to check if conversation is within 24-hour messaging window
function isWithinMessagingWindow(lastMessageAt: Date): boolean {
  const now = new Date();
  const diffMs = now.getTime() - lastMessageAt.getTime();
  const diffHours = diffMs / (60 * 60 * 1000);
  return diffHours < 24;
}

// Helper function to send message via platform API
async function sendMessage(
  conversation: any,
  content: string,
  connection: any
): Promise<void> {
  const axios = (await import('axios')).default;

  // Check 24-hour messaging window for Meta platforms
  if (['whatsapp', 'facebook', 'instagram'].includes(conversation.platform)) {
    if (!isWithinMessagingWindow(conversation.lastMessageAt)) {
      throw new Error('Cannot send message: 24-hour messaging window has expired. The customer must initiate contact again.');
    }
  }

  if (conversation.platform === 'whatsapp') {
    await axios.post(
      `https://graph.facebook.com/v18.0/${connection.whatsappPhoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: conversation.customerPhone,
        type: 'text',
        text: { body: content },
      },
      {
        headers: { Authorization: `Bearer ${connection.accessToken}` },
      }
    );
  } else if (conversation.platform === 'facebook') {
    await axios.post(
      `https://graph.facebook.com/v18.0/${connection.pageId}/messages`,
      {
        recipient: { id: conversation.platformUserId },
        message: { text: content },
        messaging_type: 'MESSAGE_TAG',
        tag: 'HUMAN_AGENT',
      },
      {
        headers: { Authorization: `Bearer ${connection.accessToken}` },
      }
    );
  } else if (conversation.platform === 'instagram') {
    await axios.post(
      `https://graph.facebook.com/v18.0/${connection.pageId}/messages`,
      {
        recipient: { id: conversation.platformUserId },
        message: { text: content },
      },
      {
        headers: { Authorization: `Bearer ${connection.accessToken}` },
      }
    );
  }
}

// Helper function to send image via platform API
async function sendImageMessage(
  conversation: any,
  imageUrl: string,
  caption: string,
  connection: any
): Promise<void> {
  const axios = (await import('axios')).default;

  if (['whatsapp', 'facebook', 'instagram'].includes(conversation.platform)) {
    if (!isWithinMessagingWindow(conversation.lastMessageAt)) {
      throw new Error('Cannot send message: 24-hour messaging window has expired.');
    }
  }

  if (conversation.platform === 'whatsapp') {
    await axios.post(
      `https://graph.facebook.com/v21.0/${connection.whatsappPhoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: conversation.customerPhone,
        type: 'image',
        image: { link: imageUrl, ...(caption && { caption }) },
      },
      {
        headers: { Authorization: `Bearer ${connection.accessToken}` },
      }
    );
  }
}

// GET /api/media/signed-url - Get signed S3 URL for viewing images
router.get(
  '/media/signed-url',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { url } = req.query;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL parameter required' });
      }

      const awsAccessKey = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
      const awsSecretKey = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
      const awsRegion = process.env.S3_REGION || process.env.AWS_REGION || 'eu-west-2';
      const s3Bucket = process.env.S3_MEDIA_BUCKET || process.env.S3_BUCKET || 'receptionmate-recordings';

      if (!awsAccessKey || !awsSecretKey) {
        return res.status(500).json({ error: 'S3 not configured' });
      }

      const parsedUrl = new URL(url);
      const s3Key = parsedUrl.pathname.replace(/^\//, '');

      const s3 = new S3Client({
        region: awsRegion,
        credentials: { accessKeyId: awsAccessKey, secretAccessKey: awsSecretKey },
      });

      const signedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key }),
        { expiresIn: 3600 }
      );

      res.json({ success: true, signedUrl });
    } catch (error) {
      console.error('Failed to generate signed URL:', error);
      res.status(500).json({ error: 'Failed to generate signed URL' });
    }
  }
);

export default router;
