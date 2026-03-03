import { Router } from 'express';
import { prisma } from '../db.js';
import { routeChatMessage } from '../services/chatAgentRouter.js';

const router = Router();

/**
 * Split a single agent response into multiple natural chat bubbles.
 * Only splits when it genuinely feels human — short warm opener + distinct question,
 * or explicit paragraph break. Long flowing answers stay as one bubble.
 */
function splitIntoMessages(text: string): string[] {
  if (!text) return [text];

  // Always split on explicit double newlines (agent intentionally separated them)
  const paragraphs = text.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
  if (paragraphs.length > 1) {
    // Cap at 3 bubbles
    if (paragraphs.length > 3) {
      return [...paragraphs.slice(0, 2), paragraphs.slice(2).join(' ')];
    }
    return paragraphs;
  }

  // Single paragraph — only split if it has a short warm opener followed by a question.
  // Pattern: "<opener of ≤90 chars ending in ! or .> <question ending in ?>"
  // This catches "Nice to meet you Dan! What's your reg?" but NOT long explanatory sentences.
  const sentences = text.match(/[^.!?]+[.!?]+[\s"')]*|[^.!?]+$/g) || [];
  const cleaned = sentences.map(s => s.trim()).filter(Boolean);

  if (cleaned.length < 2) return [text];

  // Find the first question sentence
  const firstQIdx = cleaned.findIndex(s => s.endsWith('?'));
  if (firstQIdx <= 0) return [text]; // no question, or question is the very first sentence

  const intro = cleaned.slice(0, firstQIdx).join(' ');
  const rest = cleaned.slice(firstQIdx).join(' ');

  // Only split if the intro is short (feels like a warm acknowledgement, not a full explanation)
  // and the rest is a single clear question (not a long compound sentence)
  const introShort = intro.length <= 90;
  const restConcise = rest.length <= 120;

  if (introShort && restConcise) {
    return [intro, rest];
  }

  return [text];
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

    // Get AI response — router selects the correct agent based on agentScript
    const agentResponse = await routeChatMessage(
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
    const isQuota = error instanceof Error && error.message === 'INSUFFICIENT_QUOTA';
    res.status(500).json({ 
      error: isQuota ? 'Chat temporarily unavailable' : 'Failed to process message',
      message: isQuota
        ? 'Our chat service is temporarily unavailable. Please call us directly.'
        : error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
