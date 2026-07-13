#!/usr/bin/env node
// Auto-generates a single blog post using the OpenAI API.
//
// Run via `node scripts/generate-post.mjs` from the marketing-site directory.
// Designed to be invoked on a weekly schedule from .github/workflows/blog.yml
// (see that file for the CI wiring). Requires OPENAI_API_KEY in the
// environment.
//
// The script picks a topic that hasn't been covered recently, calls GPT
// to draft a post, validates the output, and writes it to
// src/content/blog/<slug>.md. The CI job then commits and pushes the file —
// Astro picks it up at the next build.

import OpenAI from 'openai';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = join(__dirname, '..', 'src', 'content', 'blog');
const IMAGE_DIR = join(__dirname, '..', 'public', 'blog');

// Consistent visual identity across blog posts. The DALL-E prompt prefixes
// every per-post brief with this so cards on the /blog index feel like one
// family, not a Pinterest mess.
const IMAGE_STYLE = [
  'A documentary photograph in a real UK independent garage workshop.',
  'Natural daylight, slightly desaturated, lightly cinematic.',
  'No text anywhere in the image. No logos. No human faces visible.',
  'Composition leaves clean space on the right third for an overlay headline.',
].join(' ');

// Buyer-intent topic pillars. The model picks one we haven't covered.
// Order matters for the prompt — first match wins. Add new topics here as
// the keyword research turns up new high-intent searches.
const TOPIC_PILLARS = [
  {
    key: 'mot-season',
    angle: 'Practical advice for UK independent garages handling MOT-season call volume — capacity planning, common booking patterns, when AI receptionists pay back fastest.',
  },
  {
    key: 'garage-hive-integration',
    angle: 'How Garage Hive integrates with AI receptionists — what the integration actually does during a call, the data fields, common setup mistakes, what to ask the vendor.',
  },
  {
    key: 'tyresoft-integration',
    angle: 'Working with Tyresoft alongside an AI receptionist — managing tyre stock enquiries, quoting fitments, when the AI hands off to a human.',
  },
  {
    key: 'first-time-fix',
    angle: 'How AI receptionists improve first-time-fix rates in independent garages by capturing better diagnostic context on the call.',
  },
  {
    key: 'multi-site-groups',
    angle: 'AI receptionists for multi-site garage groups — call routing, branch handoffs, group reporting, the things that break at 5+ sites.',
  },
  {
    key: 'human-vs-ai',
    angle: 'When to use an AI receptionist vs. a human answering service vs. an in-house receptionist for a UK garage — honest tradeoffs, not a sales pitch.',
  },
  {
    key: 'recovering-missed-calls',
    angle: 'Practical playbook for recovering missed calls in a UK garage — outbound callbacks, SMS follow-up, the ROI of AI overflow.',
  },
  {
    key: 'ev-servicing-calls',
    angle: 'How EV servicing is changing the calls that come into UK independents — quotes, booking patterns, customer expectations, AI handling.',
  },
  {
    key: 'tyre-replacement-enquiries',
    angle: 'Handling tyre-replacement enquiries on the phone for tyre shops and generalist garages — typical price ladders, brand swaps, the AI conversation flow.',
  },
  {
    key: 'workshop-capacity-planning',
    angle: 'Workshop capacity planning when an AI receptionist captures every call — what to do with the booking deluge in week one.',
  },
];

function listExistingPosts() {
  if (!existsSync(BLOG_DIR)) return [];
  return readdirSync(BLOG_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const content = readFileSync(join(BLOG_DIR, f), 'utf8');
      const titleMatch = content.match(/title:\s*"([^"]+)"/);
      const keyMatch = content.match(/topicKey:\s*"?([a-z0-9-]+)"?/);
      return { filename: f, title: titleMatch ? titleMatch[1] : f, topicKey: keyMatch ? keyMatch[1] : null };
    });
}

function pickTopic(existing) {
  // Rotate topics evenly by picking the LEAST-covered pillar. Coverage is read
  // from each post's `topicKey` frontmatter (stamped at generation time), with
  // a filename-substring fallback for older posts that predate that field.
  //
  // (The previous version compared a pillar's key against post *filenames* —
  // but filenames are slugs of the AI-written title, which rarely contain the
  // key, so the same early pillar got picked every run. That's why the blog
  // filled up with near-duplicate Garage Hive posts.)
  const counts = new Map(TOPIC_PILLARS.map((t) => [t.key, 0]));
  for (const p of existing) {
    let key = p.topicKey && counts.has(p.topicKey) ? p.topicKey : null;
    if (!key) {
      const fname = p.filename.toLowerCase();
      const hit = TOPIC_PILLARS.find((t) => fname.includes(t.key));
      key = hit ? hit.key : null;
    }
    if (key) counts.set(key, counts.get(key) + 1);
  }
  let best = TOPIC_PILLARS[0];
  let bestCount = Infinity;
  for (const t of TOPIC_PILLARS) {
    const n = counts.get(t.key);
    if (n < bestCount) { bestCount = n; best = t; }
  }
  return best;
}

const SYSTEM_PROMPT = `You are a senior content writer producing posts for ReceptionMate's blog.

ReceptionMate is the AI receptionist built specifically for UK garages. It answers every call,
captures the booking, and pushes it straight into the garage's diary (Garage Hive, Tyresoft, etc.).
The audience is UK garage owners, service managers and group operators — practical operators,
not marketers.

Voice & tone:
- Plain English. No corporate filler ("in today's fast-paced market…", "leveraging cutting-edge…").
- Honest. If a thing has tradeoffs, say so.
- Operator-first. Concrete examples beat abstractions. Specific numbers beat ranges.
- UK English spelling (tyre, not tire; centre, not center; £ not $).
- Never say "I" or "we" gratuitously. The brand is the subtle frame.

Structure:
- 700–950 words.
- 3 to 5 H2 sections.
- One H1 (the title only — Astro renders it from frontmatter, do NOT include it in the body).
- Markdown only. No HTML.
- End with a soft CTA linking to /get-started or /case-studies — one sentence, no hard sell.

Do not invent specific statistics or named third-party products beyond what's general knowledge.
Hedged ranges are fine ("typically 20–35%"). Made-up "we surveyed 500 garages" is not.

OUTPUT FORMAT (exactly this, nothing else):
---
title: "<60-80 character SEO title>"
description: "<150-160 character meta description>"
publishedAt: <today's date in YYYY-MM-DD>
author: auto
tags: ["<tag1>", "<tag2>", "<tag3>"]
---

<the post body in markdown, starting with a single intro paragraph, no H1>
`;

async function generate() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not set. Aborting.');
    process.exit(1);
  }

  const existing = listExistingPosts();
  const topic = pickTopic(existing);
  console.log(`Picked topic: ${topic.key}`);
  console.log(`Existing posts: ${existing.length}`);

  const client = new OpenAI({ apiKey });

  const today = new Date().toISOString().slice(0, 10);
  const userPrompt = `Today's date is ${today}.

Write a fresh blog post on this angle:

${topic.angle}

Make it the most useful 800-word read a UK garage owner could find on this topic in 2026.
The piece must be standalone — assume the reader has never heard of ReceptionMate.

Use these existing post titles to AVOID overlap:
${existing.map((p) => `- ${p.title}`).join('\n') || '(none yet)'}

Remember: frontmatter then body. No H1 in the body. UK English. End with a soft single-sentence CTA.`;

  const response = await client.chat.completions.create({
    model: 'gpt-5',
    max_completion_tokens: 4000,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });

  const text = (response.choices?.[0]?.message?.content ?? '').trim();

  // Validate basic shape: needs frontmatter and a body.
  if (!text.startsWith('---')) {
    console.error('Model output did not start with frontmatter. Aborting.');
    console.error(text.slice(0, 400));
    process.exit(2);
  }

  // Pull the slug from the title in the frontmatter and write the file.
  const titleMatch = text.match(/title:\s*"([^"]+)"/);
  if (!titleMatch) {
    console.error('Could not parse title from model output. Aborting.');
    process.exit(3);
  }
  const slug = slugify(titleMatch[1]);
  if (existing.some((p) => p.filename === `${slug}.md`)) {
    console.error(`Slug collision: ${slug}. Aborting to avoid clobbering an existing post.`);
    process.exit(4);
  }

  // Generate a hero image via DALL-E that matches the post topic.
  const imageInfo = await generateHeroImage(client, slug, titleMatch[1], topic);

  // Always stamp the topic key so the next run's rotation is reliable.
  let out = text.replace(
    /^(---\n[\s\S]*?)\n---/m,
    (_, fm) => `${fm}\ntopicKey: "${topic.key}"\n---`,
  );

  // Inject heroImage + heroImageAlt into the frontmatter before writing.
  // We splice them in just before the closing `---` so they keep the same
  // visual grouping as title/description.
  if (imageInfo) {
    out = out.replace(
      /^(---\n[\s\S]*?)\n---/m,
      (_, fm) =>
        `${fm}\nheroImage: "${imageInfo.path}"\nheroImageAlt: "${imageInfo.alt.replace(/"/g, '\\"')}"\n---`,
    );
  }

  const outPath = join(BLOG_DIR, `${slug}.md`);
  writeFileSync(outPath, out + '\n', 'utf8');
  console.log(`Wrote ${outPath}`);
}

// Generate a DALL-E hero image for the post. Returns { path, alt } or null
// on failure — we never let an image-gen problem block post publication.
async function generateHeroImage(client, slug, title, topic) {
  try {
    if (!existsSync(IMAGE_DIR)) mkdirSync(IMAGE_DIR, { recursive: true });
    const prompt = `${IMAGE_STYLE}\n\nSubject: a scene that illustrates "${title}" in the context of a UK independent garage. ${topic.angle}`;
    const res = await client.images.generate({
      model: 'gpt-image-1',
      prompt,
      size: '1536x1024',
      quality: 'medium',
      n: 1,
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) {
      console.warn('Image generation returned no data; continuing without hero image.');
      return null;
    }
    const outPath = join(IMAGE_DIR, `${slug}.png`);
    writeFileSync(outPath, Buffer.from(b64, 'base64'));
    const publicPath = `/blog/${slug}.png`;
    const alt = `Illustration for "${title}"`;
    console.log(`Wrote ${outPath}`);
    return { path: publicPath, alt };
  } catch (err) {
    console.warn('Image generation failed, continuing without hero image:', err?.message ?? err);
    return null;
  }
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

generate().catch((err) => {
  console.error('Generation failed:', err);
  process.exit(99);
});
