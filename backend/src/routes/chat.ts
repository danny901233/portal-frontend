import { Router } from 'express';
import { prisma } from '../db.js';
import { getChatAgentResponse } from '../services/chatAgent.js';

const router = Router();

// Web chat endpoint for widget
router.post('/chat/widget', async (req, res) => {
  try {
    const { garageId, message, conversationId } = req.body;

    if (!garageId || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Find or create conversation
    let conversation;
    if (conversationId) {
      conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
      });
    }

    if (!conversation) {
      // Create new web chat conversation
      conversation = await prisma.conversation.create({
        data: {
          garageId,
          platform: 'web',
          platformUserId: `web_${Date.now()}`,
          platformUserName: 'Website Visitor',
          status: 'active',
        },
      });
    }

    // Save user message
    await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: message,
      },
    });

    // Get AI response
    const agentResponse = await getChatAgentResponse(
      garageId,
      message,
      conversation.id
    );

    // Save AI response
    await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: agentResponse.content,
      },
    });

    res.json({
      conversationId: conversation.id,
      response: agentResponse.content,
      needsHumanAssistance: agentResponse.needsHumanAssistance,
    });
  } catch (error) {
    console.error('Web chat error:', error);
    res.status(500).json({ 
      error: 'Failed to process message',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
