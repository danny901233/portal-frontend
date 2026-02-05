import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// GET /api/garages/:garageId/conversations - List conversations with filters
router.get(
  '/garages/:garageId/conversations',
  authenticate,
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
        },
        orderBy: { lastMessageAt: 'desc' },
      });

      // Group conversations by phone number
      const groupedByPhone = new Map<string, any[]>();
      const withoutPhone: any[] = [];

      for (const conv of allConversations) {
        if (conv.customerPhone) {
          const existing = groupedByPhone.get(conv.customerPhone) || [];
          existing.push(conv);
          groupedByPhone.set(conv.customerPhone, existing);
        } else {
          withoutPhone.push(conv);
        }
      }

      // Merge conversations with same phone number
      const mergedConversations = [];

      for (const [phone, convs] of groupedByPhone.entries()) {
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
            customerPhone: phone,
            customerId: latestConv.customerId,
            customerName: latestConv.customerName,
            status: latestConv.status,
            unreadCount: totalUnread,
            lastMessageAt: latestConv.lastMessageAt,
            messages: [latestMessage],
            conversationIds: convs.map(c => c.id), // Store all conversation IDs
          });
        }
      }

      // Add conversations without phone numbers
      mergedConversations.push(...withoutPhone);

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

      // If this conversation has a phone number, fetch ALL conversations with same phone
      let allMessages = conversation.messages;
      let allConversations = [conversation];

      if (conversation.customerPhone) {
        const relatedConversations = await prisma.chatConversation.findMany({
          where: {
            garageId: conversation.garageId,
            customerPhone: conversation.customerPhone,
          },
          include: {
            messages: {
              orderBy: { createdAt: 'asc' },
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

      res.json({
        success: true,
        conversation: {
          ...conversation,
          messages: allMessages,
          platforms: allConversations.map(c => c.platform),
          conversationIds: allConversations.map(c => c.id),
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
                where: { platform: { in: ['whatsapp', 'facebook', 'instagram'] } },
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

      // Update conversation
      await prisma.chatConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() },
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

// Helper function to send message via platform API
async function sendMessage(
  conversation: any,
  content: string,
  connection: any
): Promise<void> {
  const axios = (await import('axios')).default;

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
      'https://graph.facebook.com/v18.0/me/messages',
      {
        recipient: { id: conversation.customerId },
        message: { text: content },
      },
      {
        headers: { Authorization: `Bearer ${connection.accessToken}` },
      }
    );
  } else if (conversation.platform === 'instagram') {
    await axios.post(
      'https://graph.facebook.com/v18.0/me/messages',
      {
        recipient: { id: conversation.customerId },
        message: { text: content },
      },
      {
        headers: { Authorization: `Bearer ${connection.accessToken}` },
      }
    );
  }
}

export default router;
