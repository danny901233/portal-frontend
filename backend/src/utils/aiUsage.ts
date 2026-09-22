// What a chat message actually costs us.
//
// Voice has told us this for months — every call posts its LLM, TTS and STT usage to
// Call.metrics, which is how we can say a call minute costs 8-9p. Chat recorded nothing: the
// role, the text and a timestamp. So with WhatsApp moving to per-message billing, we were about
// to price per message without knowing our cost per message.
//
// Instrumented at the OpenAI client rather than where a message is saved, for two reasons. The
// writes are scattered across a dozen routes with no shared saver, and more importantly a turn
// can make SEVERAL model calls — the intent pass, the disclosure check, the reply — and only one
// of them becomes a message. Billing by messages saved would have undercounted the real spend.
//
// The context comes from AsyncLocalStorage so no call site has to pass it: a handler wraps the
// turn once and every model call underneath it is attributed to that garage and conversation.

import { AsyncLocalStorage } from 'node:async_hooks';
import OpenAI from 'openai';
import { prisma } from '../db.js';

export interface AiContext {
  garageId?: string | null;
  conversationId?: string | null;
  /** whatsapp | widget | facebook | instagram | voice-support | … */
  channel?: string | null;
  /** Which agent ran, so a costly one can be told from a cheap one. */
  agent?: string | null;
}

const store = new AsyncLocalStorage<AiContext>();

/** Run `fn` with every model call underneath it attributed to `ctx`. */
export function withAiContext<T>(ctx: AiContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

export function currentAiContext(): AiContext {
  return store.getStore() ?? {};
}

/**
 * USD per million tokens, by model. Kept here rather than written onto each row so a price change
 * is a code change and not a backfill — the rows hold tokens, which don't change.
 *
 * Cached input is charged at a discount by OpenAI; `cached` is the portion of `input` that hit
 * the cache, so uncached input is (input - cached).
 */
export const MODEL_RATES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-4o':       { input: 2.50, cached: 1.25, output: 10.00 },
  'gpt-4o-mini':  { input: 0.15, cached: 0.075, output: 0.60 },
  'gpt-4.1':      { input: 2.00, cached: 0.50, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, cached: 0.10, output: 1.60 },
};
const DEFAULT_RATE = { input: 2.00, cached: 0.50, output: 8.00 };

/** USD for one completion. Exported so a report and the writer agree on the sum. */
export function costUsd(model: string, input: number, cached: number, output: number): number {
  const r = MODEL_RATES[model] ?? MODEL_RATES[model?.replace(/-\d{4}-\d{2}-\d{2}$/, '')] ?? DEFAULT_RATE;
  const fresh = Math.max(0, input - cached);
  return (fresh * r.input + cached * r.cached + output * r.output) / 1_000_000;
}

async function record(model: string, usage: unknown): Promise<void> {
  const u = usage as {
    prompt_tokens?: number; completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
  if (!u || typeof u.prompt_tokens !== 'number') return;

  const ctx = currentAiContext();
  const input = u.prompt_tokens ?? 0;
  const output = u.completion_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;

  try {
    await prisma.chatUsage.create({
      data: {
        garageId: ctx.garageId ?? null,
        conversationId: ctx.conversationId ?? null,
        channel: ctx.channel ?? null,
        agent: ctx.agent ?? null,
        model,
        inputTokens: input,
        cachedTokens: cached,
        outputTokens: output,
        // Stored as micro-dollars (integer) so a sum never drifts the way repeated float addition
        // does, and so a row is readable without joining the rate table.
        costMicroUsd: Math.round(costUsd(model, input, cached, output) * 1_000_000),
      },
    });
  } catch (err) {
    // Never let accounting break a live conversation. A missing row is a gap in a report; a
    // thrown error here is a customer waiting on a reply that never comes.
    console.error('[AI-USAGE] could not record usage:', (err as Error).message);
  }
}

let client: OpenAI | null = null;

/**
 * The shared OpenAI client, with usage recording wrapped around chat completions.
 *
 * Each chat agent had its own getOpenAI() building its own client — eight copies, none of them
 * measuring anything. They all call this now.
 */
export function getInstrumentedOpenAI(): OpenAI {
  if (client) return client;

  const raw = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const create = raw.chat.completions.create.bind(raw.chat.completions);

  // Cast through unknown: the SDK's overloads (streaming vs not) make a faithful signature
  // unwieldy, and this wrapper is deliberately transparent — same args, same return.
  (raw.chat.completions as unknown as { create: unknown }).create = (async (...args: unknown[]) => {
    const res = await (create as (...a: unknown[]) => Promise<unknown>)(...args);
    const body = args[0] as { model?: string } | undefined;
    const out = res as { usage?: unknown } | undefined;
    // A streamed response has no usage on the object itself; those simply go unrecorded rather
    // than being guessed at.
    if (out && out.usage) void record(body?.model ?? 'unknown', out.usage);
    return res;
  }) as unknown;

  client = raw;
  return client;
}
