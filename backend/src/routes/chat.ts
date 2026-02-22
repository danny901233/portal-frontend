import { Router } from 'express';
import { prisma } from '../db.js';
import { getChatAgentResponse } from '../services/chatAgentV2.js';

const router = Router();

// Web chat endpoint for widget
router.post('/chat/widget', async (req, res) => {
  try {
    const { garageId, message, conversationId, contactPhone, contactName } = req.body;

    if (!garageId || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Find or create conversation
    let conversation;
    if (conversationId) {
      conversation = await prisma.chatConversation.findUnique({
        where: { id: conversationId },
      });
    }

    if (!conversation) {
      // Create new web chat conversation
      const cleanPhone = contactPhone ? String(contactPhone).replace(/\s+/g, '') : undefined;
      const cleanName = contactName ? String(contactName).trim() : undefined;
      conversation = await prisma.chatConversation.create({
        data: {
          garageId,
          platform: 'web',
          platformUserId: `web_${Date.now()}`,
          customerName: cleanName || 'Website Visitor',
          customerPhone: cleanPhone,
          status: 'active',
        },
      });
      console.log(`[CHAT_ROUTE] New conversation ${conversation.id}, phone: ${cleanPhone || 'none'}, name: ${cleanName || 'none'}`);
    } else if (contactPhone && !conversation.customerPhone) {
      // Update existing conversation with phone if we now have it
      const cleanPhone = String(contactPhone).replace(/\s+/g, '');
      await prisma.chatConversation.update({
        where: { id: conversation.id },
        data: { customerPhone: cleanPhone, customerName: contactName ? String(contactName).trim() : conversation.customerName },
      });
      conversation = { ...conversation, customerPhone: cleanPhone };
      console.log(`[CHAT_ROUTE] Updated conversation ${conversation.id} with phone: ${cleanPhone}`);
    }

    // Save user message
    await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: message,
      },
    });

    // Get AI response - pass both explicit seed and stored conversation phone
    const agentResponse = await getChatAgentResponse(
      garageId,
      message,
      conversation.id,
      { 
        phone: contactPhone || conversation.customerPhone || undefined, 
        name: contactName || conversation.customerName || undefined 
      }
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
