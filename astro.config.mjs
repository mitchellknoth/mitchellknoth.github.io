// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import remarkSmartypants from 'remark-smartypants';
import agentCorpus from './scripts/corpus/integration.mjs';

// Public origin for canonical URLs, RSS, and the sitemap.
const SITE = 'https://mitchellknoth.com';

// Self-hosted fonts. Files come from the pinned @fontsource packages in node_modules, so the
// build never fetches a font and the browser only requests same-origin font files. Subsets,
// unicode ranges and faces mirror what Google Fonts served before (latin + latin-ext).
const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

/**
 * One @font-face per subset, weight and style, read from an installed @fontsource package.
 * @param {string} pkg package name, e.g. `@fontsource/jetbrains-mono`
 * @param {(subset: string, weight: number, style: string) => string} file file name under `files/`
 * @param {Array<400 | 500 | 600>} weights
 * @param {Array<'normal' | 'italic'>} styles
 */
function fontsource(pkg, file, weights, styles) {
  return /** @type {const} */ ([
    { subset: 'latin', range: LATIN },
    { subset: 'latin-ext', range: LATIN_EXT },
  ]).flatMap(({ subset, range }) =>
    weights.flatMap((weight) =>
      styles.map((style) => ({
        src: /** @type {[string]} */ ([`${pkg}/files/${file(subset, weight, style)}`]),
        weight,
        style,
        unicodeRange: /** @type {[string]} */ ([range]),
      })),
    ),
  );
}

/** Static files, one per weight and style. */
const staticFiles = (/** @type {string} */ slug) => (/** @type {string} */ subset, /** @type {number} */ weight, /** @type {string} */ style) =>
  `${slug}-${subset}-${weight}-${style}.woff2`;

/**
 * @param {string} name
 * @param {string} cssVariable
 * @param {ReturnType<typeof fontsource>} variants
 * @param {string[]} fallbacks
 */
function localFamily(name, cssVariable, variants, fallbacks) {
  return {
    provider: fontProviders.local(),
    name,
    cssVariable,
    display: /** @type {const} */ ('swap'),
    // `fallbacks` starts with a size-adjusted local face (the "<Family> Fallback" faces in
    // src/styles/global.css) so the swap to the real font moves the layout by pixels, not by a re-wrap.
    // Astro's own `optimizedFallbacks` would do the same, but it declares the face for every character, and
    // the arrows (U+2192) that the served font subsets don't cover then render in Arial's long arrow instead
    // of the system one the site has always used. The site's original stacks follow as the secondary fallbacks.
    fallbacks: [`${name} Fallback`, ...fallbacks],
    optimizedFallbacks: false,
    options: { variants: /** @type {[typeof variants[number], ...typeof variants]} */ (variants) },
  };
}

// https://astro.build/config
export default defineConfig({
  site: SITE,
  // Keep the development-only overlay out of headed review and pointer tests.
  devToolbar: { enabled: false },
  fonts: [
    localFamily('Instrument Serif', '--font-instrument-serif', fontsource('@fontsource/instrument-serif', staticFiles('instrument-serif'), [400], ['normal', 'italic']), [
      'ui-serif',
      'Charter',
      'Georgia',
      'Times New Roman',
      'serif',
    ]),
    // Google served Inter as one variable file behind three faces (400, 500, 600). Keep that shape:
    // `<strong>` (700) then renders from the variable axis exactly as before.
    localFamily('Inter', '--font-inter', fontsource('@fontsource-variable/inter', (subset, _weight, style) => `inter-${subset}-wght-${style}.woff2`, [400, 500, 600], ['normal']), [
      'ui-sans-serif',
      '-apple-system',
      'BlinkMacSystemFont',
      'Segoe UI',
      'sans-serif',
    ]),
    localFamily('JetBrains Mono', '--font-jetbrains-mono', fontsource('@fontsource/jetbrains-mono', staticFiles('jetbrains-mono'), [400, 500], ['normal']), [
      'ui-monospace',
      'SFMono-Regular',
      'Menlo',
      'Consolas',
      'monospace',
    ]),
  ],
  // React renders one island: the homepage agent chat (src/components/agent). No other page ships it.
  integrations: [mdx(), sitemap(), agentCorpus(), react({ include: ['**/components/agent/**', '**/components/ui/**', '**/components/dev/**', '**/components/site/**'] })],
  vite: {
    plugins: [tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          // Astro names a page's extracted stylesheet like `index@_@astro.<hash>.css`. Workers static assets
          // answer a path with an `@` by redirecting (307) to its percent-encoded form, so the request costs a
          // round trip and tests/workers-parity.spec.ts fails. Keep emitted asset names to URL-safe characters.
          assetFileNames: (/** @type {{ names?: string[], name?: string }} */ asset) => {
            const name = (asset.names?.[0] ?? asset.name ?? 'asset').replace(/\.[^./]+$/, '').replace(/[^\w.-]+/g, '-');
            return `_astro/${name}.[hash][extname]`;
          },
        },
      },
    },
    // Pre-bundle at dev-server start what Vite would otherwise discover mid-load (the agent island's
    // dependencies and Astro's view-transition modules). Discovered late, they make Vite reload the
    // page while the island's module is loading, which fails Playwright runs against a cold server.
    optimizeDeps: {
      include: [
        'astro/virtual-modules/transitions-router.js',
        'astro/virtual-modules/transitions-types.js',
        'astro/virtual-modules/transitions-events.js',
        'astro/virtual-modules/transitions-swap-functions.js',
        '@base-ui/react/button',
        '@base-ui/react/collapsible',
        '@base-ui/react/merge-props',
        '@base-ui/react/use-render',
        '@shadcn/react/message-scroller',
        'class-variance-authority',
        'cn',
        'lucide-react',
      ],
    },
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
