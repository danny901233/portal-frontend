// Staff-side translation for non-English customer threads.
//
// A UK garage with Polish-speaking WhatsApp customers gets a thread its front desk cannot
// read. The agent already mirrors the customer's language on its own (the clean chat agents
// script no English, so Polish in gives Polish out), so the gap is not the conversation —
// it is the staff reading it and replying to it.
//
// Rule: `ChatMessage.content` is ALWAYS what went over the wire, in the language it was sent
// in. Nothing here ever rewrites it. Translations sit alongside in `translatedContent` and are
// generated once, lazily, then reused.

import { prisma } from '../db.js';
import { getInstrumentedOpenAI } from '../utils/aiUsage.js';

const ENGLISH_TAGS = new Set(['en', 'eng', 'engb', 'enus', 'english']);

/**
 * Is this language one we'd leave alone?
 *
 * An unknown language counts as English: a thread we could not classify must not sprout a
 * translate button that then shows the staff member the same text back.
 */
export function isEnglish(lang?: string | null): boolean {
  if (!lang) return true;
  const normalised = lang.toLowerCase().replace(/[^a-z]/g, '');
  if (!normalised) return true;
  return ENGLISH_TAGS.has(normalised);
}

/** The shape this module needs off a ChatMessage row — keeps it testable without Prisma. */
export interface TranslatableMessage {
  id: string;
  content: string;
  translatedContent: string | null;
}

/**
 * Which of these rows still need a model call?
 *
 * Skips anything already cached, and anything with no prose to translate: image placeholders,
 * blanks, and the `[Context: ...]` preamble the agent prepends, which the inbox already hides
 * from staff and which would otherwise cost a translation on every single thread.
 */
export function messagesNeedingTranslation<T extends TranslatableMessage>(messages: T[]): T[] {
  return messages.filter((m) => {
    if (m.translatedContent) return false;
    const text = (m.content || '').trim();
    if (!text) return false;
    if (text === '[Image]') return false;
    if (text.startsWith('[Context:')) return false;
    return true;
  });
}

/** One model round-trip. Injected so the logic above it is testable without a network call. */
export type ChatCompleteFn = (system: string, user: string) => Promise<string>;

/**
 * Translate a batch of strings into `targetLanguage`, preserving order.
 *
 * Batching keeps a 40-message thread to one model call, but it introduces the failure that
 * matters here: if the model returns a different number of strings than it was given, a naive
 * zip silently shifts every translation onto the wrong message — and a staff member reads a
 * confident mistranslation with no sign anything went wrong. So a count mismatch throws, and
 * the caller shows the untranslated thread instead.
 */
export async function translateTexts(
  texts: string[],
  targetLanguage: string,
  complete: ChatCompleteFn,
): Promise<string[]> {
  if (texts.length === 0) return [];

  const system =
    `You are translating messages between a UK car garage and its customer into ${targetLanguage}. `
    + `Translate each message faithfully, keeping the tone and keeping motor-trade terms correct `
    + `(MOT, service, tyres, registration). Leave registration plates, prices, dates and names `
    + `exactly as they are. Do not answer, summarise or add anything.\n`
    + `Reply with JSON only: {"translations": [...]} — exactly ${texts.length} `
    + `item${texts.length === 1 ? '' : 's'}, in the same order as the input.`;

  const user = JSON.stringify({ messages: texts });
  const raw = await complete(system, user);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Translation failed: could not parse model output: ${raw.slice(0, 120)}`);
  }

  const translations = (parsed as { translations?: unknown })?.translations;
  if (!Array.isArray(translations)) {
    throw new Error(`Translation failed: could not parse a translations array from: ${raw.slice(0, 120)}`);
  }
  if (translations.length !== texts.length) {
    throw new Error(
      `Translation failed: asked for ${texts.length} translations, got ${translations.length}`,
    );
  }

  return translations.map((t) => String(t ?? ''));
}

/**
 * Which language is this message in? Returns an English language NAME ("Polish"), which is
 * both what the translate prompt wants and what the inbox shows the staff member.
 *
 * Returns null when we cannot tell. Null is stored as "not detected", which `isEnglish` treats
 * as English — so an unclear answer leaves the thread exactly as it is today rather than
 * guessing and sprouting a translate button that does nothing.
 */
export async function detectLanguage(
  text: string,
  complete: ChatCompleteFn,
): Promise<string | null> {
  const sample = (text || '').trim();
  if (!sample) return null;

  const system =
    'Identify the language of the message. Reply with the English name of the language and '
    + 'nothing else, for example: English, Polish, Romanian, Urdu.';

  const raw = await complete(system, sample.slice(0, 500));
  const cleaned = (raw || '').trim().replace(/[.!]+$/, '').trim();

  // A language name, not a sentence about one. Anything else means the model did not do as it
  // was told, and a sentence stored here would end up in the UI and in the translate prompt.
  if (!/^[A-Za-z][A-Za-z -]{1,24}$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * The real model call. Thin adapter over the instrumented client, so a thread translation shows
 * up in per-garage AI spend alongside the agent's own calls rather than quietly off-book.
 *
 * gpt-4o-mini: this is translation, not reasoning, and it is the same model the other chat-side
 * side-tasks already use.
 */
export const openaiComplete: ChatCompleteFn = async (system, user) => {
  const response = await getInstrumentedOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return response.choices[0]?.message?.content || '';
};

/**
 * Detection wants a bare word back, not JSON, so it gets its own adapter.
 */
export const openaiCompletePlain: ChatCompleteFn = async (system, user) => {
  const response = await getInstrumentedOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 10,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return response.choices[0]?.message?.content || '';
};

// ── Conversation-level orchestration ────────────────────────────────────────

/**
 * Detect and store the customer's language, once per conversation.
 *
 * Called fire-and-forget from the inbound webhook: it must never delay or break taking a
 * customer's message. Does nothing once a language is on the conversation, so this is one cheap
 * call per conversation lifetime, not one per message.
 */
export async function ensureConversationLanguage(
  conversationId: string,
  text: string,
  current: string | null,
): Promise<void> {
  if (current) return;
  try {
    const detected = await detectLanguage(text, openaiCompletePlain);
    if (!detected) return;
    await prisma.chatConversation.update({
      where: { id: conversationId },
      data: { customerLanguage: detected },
    });
  } catch (err) {
    console.error('[TRANSLATE] language detection failed:', err);
  }
}

/**
 * Translate everything in a thread that isn't already translated into English, and cache it.
 *
 * Returns the language it translated from so the inbox can label the thread. Repeat calls are
 * nearly free — only messages that arrived since the last call need the model.
 */
export async function translateThreadToEnglish(
  conversationId: string,
): Promise<{ language: string | null; translated: number }> {
  const conversation = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
    select: {
      customerLanguage: true,
      messages: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, content: true, translatedContent: true },
      },
    },
  });
  if (!conversation) throw new Error('Conversation not found');

  const pending = messagesNeedingTranslation(conversation.messages);
  if (pending.length === 0) {
    return { language: conversation.customerLanguage, translated: 0 };
  }

  const translations = await translateTexts(
    pending.map((m) => m.content),
    'English',
    openaiComplete,
  );

  // The source language label is what we detected for the thread, falling back to a plain
  // marker so a translated message is never left looking untranslated.
  const from = conversation.customerLanguage || 'the customer';

  await prisma.$transaction(
    pending.map((m, i) =>
      prisma.chatMessage.update({
        where: { id: m.id },
        data: { translatedContent: translations[i], translatedFrom: from },
      }),
    ),
  );

  return { language: conversation.customerLanguage, translated: pending.length };
}

/**
 * Turn a staff member's English into the customer's language for sending.
 *
 * Throws if translation fails. The caller must NOT fall back to sending the English — a garage
 * that thinks it replied in Polish and actually sent English has been given a false receipt.
 */
export async function translateForCustomer(text: string, language: string): Promise<string> {
  const [translated] = await translateTexts([text], language, openaiComplete);
  return translated;
}
