import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// One Markdown file per guide in src/content/guides/. The file name is the
// slug. A guide without these fields fails the build, not the site.
const guides = defineCollection({
  loader: glob({ base: './src/content/guides', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string(),
    description: z.string().max(160),
    // The search query the guide answers (the loop reads this to avoid
    // writing the same guide twice).
    query: z.string(),
    publishDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.enum(['scoring', 'rankings', 'organizing', 'apps'])).default([]),
  }),
});

export const collections = { guides };
