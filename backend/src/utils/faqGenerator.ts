// Auto-populate a garage's FAQs at signup. Strategy (chosen by product):
//   1. Seed a curated industry-standard set immediately (deterministic, instant).
//   2. In the background, if the garage has a scrapable website, scrape it and ask
//      OpenAI to draft tailored FAQs — replacing the defaults when good ones come back.
// The garage can edit any of these afterwards in the portal.

import OpenAI from 'openai';
import { fetchWebsiteInfo } from './scraper.js';

// Matches the portal's FaqItem shape (app/agent-setup/_components/FaqsTab.tsx) so
// auto-populated FAQs render and toggle correctly in the "Smart questions & FAQs" editor.
export interface Faq {
  question: string;
  answer: string;
  active: boolean;
}

// Sensible defaults for a UK independent garage. Generic enough to be true for
// almost any garage, specific enough to be useful from day one.
export function industryDefaultFaqs(branchName: string): Faq[] {
  const name = (branchName || 'the garage').trim();
  return [
    { question: 'What are your opening hours?', answer: 'Please check our current opening hours — the team will confirm exact times when you call.', active: true },
    { question: 'Do you do MOTs?', answer: `Yes, ${name} carries out MOT testing. Let us know your registration and we'll get you booked in.`, active: true },
    { question: 'Do I need to book in advance?', answer: 'Booking ahead is best so we can guarantee a slot, but get in touch and we\'ll always try to fit you in as soon as we can.', active: true },
    { question: 'What payment methods do you accept?', answer: 'We accept all major debit and credit cards as well as cash. Payment is taken once the work is complete.', active: true },
    { question: 'Can I get a quote before booking?', answer: 'Of course — tell us your vehicle registration and what you need doing, and we\'ll give you a price before any work goes ahead.', active: true },
    { question: 'Do you offer a courtesy car or while-you-wait service?', answer: 'Availability varies — let the team know what you need when you call and we\'ll do our best to help.', active: true },
  ];
}

function getClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// Draft tailored FAQs from the garage's website content. Returns [] on any failure
// (caller keeps the industry defaults).
export async function generateFaqsFromWebsite(websiteUrl: string, branchName: string): Promise<Faq[]> {
  const url = (websiteUrl || '').trim();
  if (!url) return [];
  const client = getClient();
  if (!client) return [];

  let context = '';
  try {
    const info = await fetchWebsiteInfo(url);
    const parts = [
      info.title && `Title: ${info.title}`,
      info.description && `Description: ${info.description}`,
      info.address && `Address: ${info.address}`,
      info.phoneNumbers?.length && `Phone: ${info.phoneNumbers.join(', ')}`,
      info.hours?.length && `Hours: ${info.hours.join(' | ')}`,
      info.knowledgeChunks?.length && `Content:\n${info.knowledgeChunks.slice(0, 12).join('\n')}`,
    ].filter(Boolean);
    context = parts.join('\n').slice(0, 6000);
  } catch (err) {
    console.warn('[FAQ] website scrape failed, skipping AI generation:', err);
    return [];
  }
  if (context.replace(/\s/g, '').length < 80) return []; // too little to work with

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You write FAQs for a UK car garage\'s phone receptionist. Using ONLY the supplied website content, produce 5–8 concise, accurate question/answer pairs a caller might ask (services offered, MOTs, booking, payment, location, specialisms). ' +
            'Answers must be 1–2 sentences, factual, and never invent prices, hours, or services not supported by the content. ' +
            'Reply as JSON: {"faqs":[{"question":"...","answer":"..."}]}',
        },
        { role: 'user', content: `Garage: ${branchName}\n\nWebsite content:\n${context}` },
      ],
    });
    const raw = completion.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    const items: Faq[] = Array.isArray(parsed?.faqs) ? parsed.faqs : [];
    const clean: Faq[] = items
      .filter((f) => f && typeof f.question === 'string' && typeof f.answer === 'string')
      .map((f) => ({ question: f.question.trim().slice(0, 300), answer: f.answer.trim().slice(0, 1000), active: true }))
      .filter((f) => f.question && f.answer)
      .slice(0, 8);
    return clean;
  } catch (err) {
    console.error('[FAQ] OpenAI generation failed:', err);
    return [];
  }
}
