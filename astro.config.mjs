// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import remarkSmartypants from 'remark-smartypants';

// Public origin for canonical URLs, RSS, and the sitemap.
const SITE = 'https://mitchellknoth.com';

// https://astro.build/config
export default defineConfig({
  site: SITE,
  // Keep the development-only overlay out of headed review and pointer tests.
  devToolbar: { enabled: false },
  integrations: [mdx(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    // remark-smartypants ships unified types that don't line up with Astro's stricter
    // Root-node remark types; the plugin is correct at runtime, so cast past the mismatch.
    remarkPlugins: [/** @type {any} */ (remarkSmartypants)],
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark-dimmed',
      },
      wrap: true,
    },
  },
});
