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

      const conversations = await prisma.chatConversation.findMany({
        where,
        include: {
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { lastMessageAt: 'desc' },
      });

      res.json({ success: true, conversations });
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

      // Mark as read
      if (conversation.unreadCount > 0) {
        await prisma.chatConversation.update({
          where: { id: conversationId },
          data: { unreadCount: 0 },
        });
      }

      res.json({ success: true, conversation });
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
