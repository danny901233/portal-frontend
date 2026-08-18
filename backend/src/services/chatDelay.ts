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


// Split a reply into the two or three messages a person would actually send, rather than one
// paragraph. Splits on sentence boundaries only, never mid-sentence, and leaves short replies
// alone — chunking "What's your postcode?" would be worse than not chunking at all.
export function splitIntoMessages(text: string, maxChunks = 3): string[] {
  const clean = (text || '').trim();
  if (clean.length < 180) return [clean];

  // Split only where a sentence genuinely ends: punctuation followed by whitespace. The lookbehind
  // matters — an earlier version used a match() pattern that broke inside "£319.99" and silently
  // dropped the rest of the sentence, so a customer would have been quoted a mangled price.
  const sentences = clean.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
  if (sentences.length < 2) return [clean];

  const target = Math.ceil(clean.length / Math.min(maxChunks, Math.ceil(clean.length / 200)));
  const chunks: string[] = [];
  let buf = '';
  for (const sentence of sentences) {
    if (buf && (buf.length + sentence.length) > target && chunks.length < maxChunks - 1) {
      chunks.push(buf.trim());
      buf = sentence;
    } else {
      buf = buf ? `${buf} ${sentence}` : sentence;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());

  // Hard guard: chunking must never change a single character of what the customer reads. If the
  // parts do not rejoin to the original, send it whole rather than risk mangling a price or a date.
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim();
  if (norm(chunks.join(' ')) !== norm(clean)) {
    console.warn('[chat-delay] chunking would alter the message — sending it whole');
    return [clean];
  }
  return chunks.filter(Boolean);
}

/**
 * Stop the agent repeating itself word for word.
 *
 * Several tool handlers return fixed lines ("I don't have any online availability showing…"),
 * so hitting the same branch twice produces the identical sentence twice. Isaac's Great Hollands
 * conversation on 18 Aug had two such pairs, one of them back to back. Nothing gives the game
 * away faster — a person never repeats thirty words exactly.
 *
 * Rather than rewrite sixty-odd scripted lines across five agents, catch it at the point of
 * sending: if this reply matches one the agent has just sent, ask a cheap model to say the same
 * thing differently. Falls back to the original if the rewrite fails — repeating beats silence.
 */
async function avoidVerbatimRepeat(conversationId: string, content: string): Promise<string> {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const recent = await prisma.chatMessage.findMany({
    where: { conversationId, role: 'assistant' },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { content: true },
  });
  if (!recent.some(m => norm(m.content || '') === norm(content))) return content;

  console.log(`[chat-delay] conv ${conversationId}: reply repeats a recent one — rephrasing`);
  try {
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.8,
      max_tokens: 160,
      messages: [
        { role: 'system', content:
          'Rewrite the message so it means exactly the same thing but is worded differently, as a '
          + 'British garage receptionist would say it on WhatsApp. Keep it the same length or shorter. '
          + 'Keep every fact, name, price, date and question. Do not add anything new. Reply with the '
          + 'rewritten message only.' },
        { role: 'user', content },
      ],
    });
    return r.choices[0]?.message?.content?.trim() || content;
  } catch (e: any) {
    console.warn('[chat-delay] rephrase failed, sending original:', e?.message);
    return content;
  }
}

/** How long since the customer was last in touch — so the agent can open like a person would. */
async function hoursSinceLastMessage(conversationId: string): Promise<number | null> {
  const prev = await prisma.chatMessage.findFirst({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    skip: 1,                       // skip the message we are replying to
    select: { createdAt: true },
  });
  if (!prev) return null;
  return (Date.now() - prev.createdAt.getTime()) / 3_600_000;
}

async function sendDelayedReply(p: HumanReplyParams): Promise<void> {
  pending.delete(p.conversationId);

  // If a human took over during the wait, don't send the bot's reply.
  const conv = await prisma.chatConversation.findUnique({
    where: { id: p.conversationId },
    select: {
      agentPaused: true, agentPausedUntil: true,
      customerPhone: true, customerName: true,
    },
  });
  if (conv?.agentPaused && (!conv.agentPausedUntil || conv.agentPausedUntil > new Date())) {
    console.log(`[chat-delay] agent paused for ${p.conversationId} — skipping reply`);
    return;
  }

  // Route once, now — the agent loads full history, so any messages batched during the
  // wait are included and answered together.
  //
  // Seed the number they are messaging from. This path is how every WhatsApp reply reaches the
  // agent, and it was passing no contact at all — so the agent asked a customer for a number it
  // was literally receiving the message from (Great Hollands, 2026-08-14: asked three times,
  // never got it, message never taken). The agent confirms the last 3 digits rather than asking.
  const seedContact = (conv?.customerPhone || conv?.customerName)
    ? { phone: conv.customerPhone || undefined, name: conv.customerName || undefined }
    : undefined;
  // A WhatsApp thread can sit dormant for days and then pick up again — Isaac's Great Hollands
  // conversation ran 14 to 18 August. Carrying on mid-sentence four days later is a giveaway, so
  // tell the agent how long it has been and let it open the way a person would.
  const gapHours = await hoursSinceLastMessage(p.conversationId);
  const gapNote = gapHours === null || gapHours < 6 ? undefined
    : gapHours < 24 ? 'earlier today'
    : gapHours < 48 ? 'yesterday'
    : `${Math.round(gapHours / 24)} days ago`;
  if (gapNote) console.log(`[chat-delay] conv ${p.conversationId}: resuming after ${gapNote}`);

  const agentResponse = await routeChatMessage(
    p.garageId, p.agentText, p.conversationId,
    gapNote ? { ...seedContact, lastContact: gapNote } : seedContact,
  );
  if (!agentResponse?.content) return;

  const content = await avoidVerbatimRepeat(p.conversationId, agentResponse.content);
  const chunks = splitIntoMessages(content);

  for (let i = 0; i < chunks.length; i++) {
    // Typing before each part, so a two-part reply looks like someone still writing rather than
    // two messages fired at once.
    await markSeen(p, true);
    await new Promise((r) => setTimeout(r, i === 0 ? rand(2_500, 5_000) : rand(1_200, 2_800)));

    await prisma.chatMessage.create({
      data: { conversationId: p.conversationId, role: 'assistant', content: chunks[i] },
    });
    try {
      await axios.post(
        `https://graph.facebook.com/v21.0/${p.phoneNumberId}/messages`,
        { messaging_product: 'whatsapp', to: p.customerPhone, type: 'text', text: { body: chunks[i] } },
        { headers: { Authorization: `Bearer ${p.accessToken}`, 'Content-Type': 'application/json' } },
      );
    } catch (e: any) {
      console.error(`[chat-delay] SEND FAILED to ${p.customerPhone}:`, JSON.stringify(e?.response?.data ?? e?.message));
      return;   // don't send part 2 if part 1 never landed
    }
  }
  console.log(`[chat-delay] sent delayed reply to ${p.customerPhone} in ${chunks.length} message(s)`);
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
