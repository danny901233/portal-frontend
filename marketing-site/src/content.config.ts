// Astro 5 content collection config. Each blog post lives at
// src/content/blog/<slug>.md with the frontmatter defined below.
// Posts come from two sources: a few hand-written seed posts, and
// the auto-generator at scripts/generate-post.mjs which runs on
// schedule via GitHub Actions.

import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishedAt: z.coerce.date(),
    // Used to badge auto-generated posts so a human editor can spot them at a
    // glance. Defaults to 'human' so seed posts don't need to set it.
    author: z.enum(['human', 'auto']).default('human'),
    // 1-3 short tags for filtering and SEO. e.g. ["guide", "ai", "garages"]
    tags: z.array(z.string()).default([]),
    // Hide a post without deleting it. Useful when a generated post is wrong
    // and we want to keep it in git history but not show it.
    draft: z.boolean().default(false),
    // Hero image — typically auto-generated via DALL-E by the post generator.
    // Path is relative to /public e.g. "/blog/my-slug.jpg".
    heroImage: z.string().optional(),
    heroImageAlt: z.string().optional(),
    // Which topic pillar the generator used — drives even topic rotation so
    // the same pillar isn't picked repeatedly. Optional (older posts lack it).
    topicKey: z.string().optional(),
  }),
});

export const collections = { blog };
