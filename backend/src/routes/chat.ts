import { Router } from 'express';
import { prisma } from '../db.js';
import { getChatAgentResponse } from '../services/chatAgentV2.js';

const router = Router();

/**
 * Split a single agent response into multiple natural chat bubbles.
 * Splits on: sentence boundaries before questions, em-dashes, and explicit \n\n.
 */
function splitIntoMessages(text: string): string[] {
  if (!text) return [];

  // First split on explicit double newlines
  const paragraphs = text.split(/\n\n+/).map(s => s.trim()).filter(Boolean);

  const bubbles: string[] = [];

  for (const para of paragraphs) {
    // Split a paragraph into sentence-level bubbles.
    // Strategy: split before a question sentence if there's already a statement before it.
    // e.g. "Nice to meet you Dan! What's your reg?" → ["Nice to meet you Dan!", "What's your reg?"]
    const sentences = para.match(/[^.!?]+[.!?]+[\s"')]*|[^.!?]+$/g) || [para];
    const cleaned = sentences.map(s => s.trim()).filter(Boolean);

    if (cleaned.length <= 1) {
      bubbles.push(para);
      continue;
    }

    // Group: keep running text together until we hit a question, then split
    let current = '';
    for (const sentence of cleaned) {
      const isQuestion = sentence.trim().endsWith('?');
      if (isQuestion && current.trim()) {
        bubbles.push(current.trim());
        bubbles.push(sentence.trim());
        current = '';
      } else {
        current = current ? current + ' ' + sentence : sentence;
      }
    }
    if (current.trim()) bubbles.push(current.trim());
  }

  // Never return more than 3 bubbles — merge excess back together
  if (bubbles.length > 3) {
    const merged = bubbles.slice(0, 2);
    merged.push(bubbles.slice(2).join(' '));
    return merged;
  }

  return bubbles.length > 0 ? bubbles : [text];
}

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

    // Save AI response (store as single string for history)
    await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: agentResponse.content,
      },
    });

    const messagesBubbles = splitIntoMessages(agentResponse.content);

    res.json({
      conversationId: conversation.id,
      response: agentResponse.content,
      messages: messagesBubbles,
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
