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
  const sentences = text.match(/[^.!?]+[.!?]+[\s"'")]*|[^.!?]+$/g) || [];
  const cleaned = sentences.map(s => s.trim()).filter(Boolean);

  if (cleaned.length < 2) return [text];

  const firstQIdx = cleaned.findIndex(s => s.endsWith('?'));
  if (firstQIdx <= 0) return [text];

  const intro = cleaned.slice(0, firstQIdx).join(' ');
  const rest = cleaned.slice(firstQIdx).join(' ');

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

    if (!garageId || typeof garageId !== 'string' || !message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate garageId is UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(garageId)) {
      return res.status(400).json({ error: 'Invalid garageId' });
    }

    // Limit message length to prevent abuse
    if (message.length > 10000) {
      return res.status(400).json({ error: 'Message too long (max 10000 characters)' });
    }

    // Find or create conversation (wrapped in serialized transaction to prevent duplicates)
    const cleanPhone = contactPhone ? String(contactPhone).replace(/\s+/g, '') : undefined;
    const cleanName = contactName ? String(contactName).trim() : undefined;

    let conversation = await prisma.$transaction(async (tx) => {
      let conv;
      if (conversationId) {
        conv = await tx.chatConversation.findUnique({
          where: { id: conversationId },
        });
      }

      if (!conv) {
        conv = await tx.chatConversation.create({
          data: {
            garageId,
            platform: 'widget',
            platformUserId: `widget_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            customerName: cleanName || 'Website Visitor',
            customerPhone: cleanPhone,
            status: 'active',
            lastMessageAt: new Date(),
          },
        });
        console.log(`[CHAT_ROUTE] New conversation ${conv.id}, phone: ${cleanPhone || 'none'}, name: ${cleanName || 'none'}`);
      } else if (contactPhone && !conv.customerPhone) {
        await tx.chatConversation.update({
          where: { id: conv.id },
          data: {
            customerPhone: cleanPhone,
            customerName: cleanName || conv.customerName,
            lastMessageAt: new Date(),
            unreadCount: { increment: 1 },
          },
        });
        conv = { ...conv, customerPhone: cleanPhone ?? null };
        console.log(`[CHAT_ROUTE] Updated conversation ${conv.id} with phone: ${cleanPhone}`);
      } else {
        // Update lastMessageAt and unreadCount for existing conversation
        await tx.chatConversation.update({
          where: { id: conv.id },
          data: { lastMessageAt: new Date(), unreadCount: { increment: 1 } },
        });
      }

      return conv;
    });

    // Check if agent is paused for this conversation
    const freshConv = await prisma.chatConversation.findUnique({
      where: { id: conversation.id },
      select: { agentPaused: true, agentPausedUntil: true },
    });
    let isAgentPaused = freshConv?.agentPaused ?? false;
    if (isAgentPaused && freshConv?.agentPausedUntil && new Date() > freshConv.agentPausedUntil) {
      await prisma.chatConversation.update({
        where: { id: conversation.id },
        data: { agentPaused: false, agentPausedUntil: null },
      });
      isAgentPaused = false;
    }

    // Save user message
    await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: message,
      },
    });

    if (isAgentPaused) {
      return res.json({
        conversationId: conversation.id,
        response: "Our team will be with you shortly.",
        messages: ["Our team will be with you shortly."],
        needsHumanAssistance: false,
      });
    }

    // Get AI response — router selects the correct agent based on agentScript
    const agentResponse = await routeChatMessage(
      garageId,
      message,
      conversation.id,
      {
        phone: contactPhone || conversation.customerPhone || undefined,
        name: contactName || (conversation.customerName && conversation.customerName !== 'Website Visitor' ? conversation.customerName : undefined) || undefined
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
