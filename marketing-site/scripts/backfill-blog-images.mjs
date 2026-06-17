#!/usr/bin/env node
// One-off: walks src/content/blog/*.md, generates a DALL-E hero image for
// any post that doesn't already have one, writes it to public/blog/, and
// rewrites the markdown frontmatter to point at it.
//
// Run once after wiring image generation:
//   OPENAI_API_KEY=sk-... node scripts/backfill-blog-images.mjs
//
// Safe to re-run — only acts on posts that don't have heroImage already.

import OpenAI from 'openai';
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { Buffer } from 'node:buffer';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = join(__dirname, '..', 'src', 'content', 'blog');
const IMAGE_DIR = join(__dirname, '..', 'public', 'blog');

const IMAGE_STYLE = [
  'A documentary photograph in a real UK independent garage workshop.',
  'Natural daylight, slightly desaturated, lightly cinematic.',
  'No text anywhere in the image. No logos. No human faces visible.',
  'Composition leaves clean space on the right third for an overlay headline.',
].join(' ');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set. Aborting.');
  process.exit(1);
}

if (!existsSync(IMAGE_DIR)) mkdirSync(IMAGE_DIR, { recursive: true });

const client = new OpenAI({ apiKey });

const files = readdirSync(BLOG_DIR).filter((f) => f.endsWith('.md'));
console.log(`Found ${files.length} posts`);

let processed = 0;
for (const file of files) {
  const path = join(BLOG_DIR, file);
  const slug = file.replace(/\.md$/, '');
  const raw = readFileSync(path, 'utf8');

  if (/^heroImage:/m.test(raw)) {
    console.log(`  skip ${file} (already has heroImage)`);
    continue;
  }

  const titleMatch = raw.match(/^title:\s*"([^"]+)"/m);
  const descMatch = raw.match(/^description:\s*"([^"]+)"/m);
  if (!titleMatch) {
    console.warn(`  skip ${file} (no title in frontmatter)`);
    continue;
  }
  const title = titleMatch[1];
  const description = descMatch?.[1] ?? '';

  console.log(`  generating image for: ${title}`);
  try {
    const prompt = `${IMAGE_STYLE}\n\nSubject: a scene that illustrates "${title}" in a UK independent garage. ${description}`;
    const res = await client.images.generate({
      model: 'gpt-image-1',
      prompt,
      size: '1536x1024',
      quality: 'medium',
      n: 1,
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) {
      console.warn(`  no image data for ${file}; skipping`);
      continue;
    }
    const imagePath = join(IMAGE_DIR, `${slug}.png`);
    writeFileSync(imagePath, Buffer.from(b64, 'base64'));

    const publicPath = `/blog/${slug}.png`;
    const alt = `Illustration for "${title}"`;
    const patched = raw.replace(
      /^(---\n[\s\S]*?)\n---/m,
      (_, fm) =>
        `${fm}\nheroImage: "${publicPath}"\nheroImageAlt: "${alt.replace(/"/g, '\\"')}"\n---`,
    );
    writeFileSync(path, patched, 'utf8');
    console.log(`  ✓ ${imagePath}`);
    processed += 1;
  } catch (err) {
    console.warn(`  failed for ${file}: ${err?.message ?? err}`);
  }
}

console.log(`Done — ${processed} post(s) updated.`);
