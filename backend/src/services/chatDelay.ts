import axios from 'axios';
import { prisma } from '../db.js';
import { routeChatMessage } from './chatAgentRouter.js';

// Human-like WhatsApp reply delay.
//
// Instead of replying to a customer instantly (which reads as a bot), we wait a
// weighted-random delay, show "seen" + "typing…", then send. Messages that arrive
// during the wait re-arm the timer so a burst gets ONE reply, not several.
//
// Distribution (per Dan, 2026-07-02): ~70% under 30s, ~25% 30s–2min, ~5% up to 5min.
// Kill switch: set env CHAT_HUMAN_DELAY=off to revert to instant replies.

export interface HumanReplyParams {
  garageId: string;
  conversationId: string;
  phoneNumberId: string;
  customerPhone: string;
  accessToken: string;
  agentText: string;
  metaMid?: string | null;
}

// conversationId -> pending reply timer (single process under pm2; lost on restart, which is fine).
const pending = new Map<string, NodeJS.Timeout>();

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function humanDelayMs(): number {
  const r = Math.random();
  if (r < 0.70) return rand(3_000, 30_000); // 70%: 3–30s
  if (r < 0.95) return rand(30_000, 120_000); // 25%: 30s–2min
  return rand(120_000, 300_000); // 5%: 2–5min
}

// Mark the customer's message as read (blue ticks) and optionally show a typing indicator.
// Best-effort — never let this block or fail the reply.
async function markSeen(p: HumanReplyParams, typing: boolean): Promise<void> {
  if (!p.metaMid) return;
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${p.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: p.metaMid,
        ...(typing ? { typing_indicator: { type: 'text' } } : {}),
      },
      { headers: { Authorization: `Bearer ${p.accessToken}`, 'Content-Type': 'application/json' } },
    );
  } catch (e: any) {
    console.warn('[chat-delay] read/typing best-effort failed:', e?.response?.data?.error?.message ?? e?.message);
  }
}

async function sendDelayedReply(p: HumanReplyParams): Promise<void> {
  pending.delete(p.conversationId);

  // If a human took over during the wait, don't send the bot's reply.
  const conv = await prisma.chatConversation.findUnique({
    where: { id: p.conversationId },
    select: { agentPaused: true, agentPausedUntil: true },
  });
  if (conv?.agentPaused && (!conv.agentPausedUntil || conv.agentPausedUntil > new Date())) {
    console.log(`[chat-delay] agent paused for ${p.conversationId} — skipping reply`);
    return;
  }

  // Route once, now — the agent loads full history, so any messages batched during the
  // wait are included and answered together.
  const agentResponse = await routeChatMessage(p.garageId, p.agentText, p.conversationId);
  if (!agentResponse?.content) return;

  // Show "typing…" for a couple of seconds right before the message lands.
  await markSeen(p, true);
  await new Promise((r) => setTimeout(r, rand(2_500, 5_000)));

  await prisma.chatMessage.create({
    data: { conversationId: p.conversationId, role: 'assistant', content: agentResponse.content },
  });
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${p.phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to: p.customerPhone, type: 'text', text: { body: agentResponse.content } },
      { headers: { Authorization: `Bearer ${p.accessToken}`, 'Content-Type': 'application/json' } },
    );
    console.log(`[chat-delay] sent delayed reply to ${p.customerPhone}`);
  } catch (e: any) {
    console.error(`[chat-delay] SEND FAILED to ${p.customerPhone}:`, JSON.stringify(e?.response?.data ?? e?.message));
  }
}

/**
 * Schedule a human-like delayed reply. Re-arms (batches) if the customer sends more
 * messages before it fires. Returns immediately — the webhook must not block.
 */
export function scheduleHumanReply(p: HumanReplyParams): void {
  if (process.env.CHAT_HUMAN_DELAY === 'off') {
    void sendDelayedReply(p).catch((e) => console.error('[chat-delay] fire error', e));
    return;
  }

  const existing = pending.get(p.conversationId);
  if (existing) clearTimeout(existing); // batch: customer sent another message — restart the wait

  void markSeen(p, false); // "seen" now
  const delay = humanDelayMs();
  const timer = setTimeout(() => {
    sendDelayedReply(p).catch((e) => console.error('[chat-delay] fire error', e));
  }, delay);
  pending.set(p.conversationId, timer);
  console.log(`[chat-delay] conv ${p.conversationId}: reply scheduled in ${Math.round(delay / 1000)}s`);
}
