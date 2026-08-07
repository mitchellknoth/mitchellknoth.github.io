import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    date: z.coerce.date(),
    draft: z.boolean().default(false),
    eyebrow: z.string().optional(),
    readingTime: z.string().optional(),
    tags: z.array(z.string()).default([]),
  }),
});

const projects = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/projects' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    period: z.string(),
    stack: z.array(z.string()).default([]),
    metric: z
      .object({
        value: z.string(),
        label: z.string(),
      })
      .optional(),
    href: z.url().optional(),
    featured: z.boolean().default(false),
    order: z.number().default(99),
    era: z.enum(['ai', 'platform']).default('platform'),
    roleTag: z.string().optional(),
  }),
});

export const collections = { posts, projects };
