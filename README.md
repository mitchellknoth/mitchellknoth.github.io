# mitchellknoth.com

Personal site. Astro 6 + Tailwind v4 + MDX, dark-first with a light mode toggle. Deployed to Cloudflare Workers static assets via GitHub Actions.

## Quick start

The toolchain is pinned with [mise](https://mise.jdx.dev): `mise install` fetches the Node version CI uses (the workflows read `mise.toml` and `mise.lock`) and
`uv`, `mise.lock` records the exact versions, and `mise tasks` lists the named commands (they call the npm scripts
below). mise is optional; plain Node 24 and `npm` work the same.

```bash
mise install       # once, if you use mise
npm install
npm run dev        # http://localhost:4321
npm run build      # production build → ./dist
npm run preview    # preview the built site
npm run quality    # design lint, type check, build, build contract, responsive Playwright contract
```

`npm run test:build` runs the Node checks over `dist/` (egress, agent corpus, eval question set);
run it after a build.

For visual critique, run `npm run test:visual:headed`. The suite opens Chromium and exercises every
public route at phone, tablet, desktop, and ultrawide viewports. Failed checks retain a screenshot and
trace in `test-results/`; CI runs the same contract before the Worker deploys.

## Deploying

The site is served from Cloudflare Workers static assets at `https://mitchellknoth.com`. Cloudflare manages registration and DNS.

1. Push to `main`. The workflow at `.github/workflows/deploy.yml` (**Deploy site**) runs `npm run quality`, then the `deploy-workers` job publishes the validated build to the Worker `mitchellknoth-com`.
2. `deploy-workers` runs only while the repository variable `CF_WORKERS_DEPLOY` is `true`; its secrets and variables are described in `docs/runbooks/workers-cutover.md`.
3. `SITE` in `astro.config.mjs` is the public origin for canonical URLs, RSS, and the sitemap. Update it if the public domain changes.

The custom domain is a Worker Custom Domain on the apex; `www` redirects to the apex with Cloudflare redirect rules. GitHub Pages was retired after the 2026-11-06 cutover; the history is in `docs/runbooks/workers-cutover.md`.

## Writing posts

Posts live in `src/content/posts/` as `.md` or `.mdx` files. Frontmatter schema is enforced by `src/content.config.ts`:

```yaml
---
title: "Your post title"
summary: "One sentence pitch. Shows up in the list and meta tags."
date: 2026-04-20
draft: false            # true = excluded from generated routes, lists, RSS
readingTime: "6 min"    # optional but recommended
tags: ["ai", "sdlc"]    # optional
---
```

Published posts render at `/writing/<filename-without-extension>/`. RSS and sitemap update automatically on build.

## Editing work / project entries

Entries live in `src/content/projects/` — one markdown file per project. Frontmatter drives the list and homepage cards, and the body renders as the case study page at `/work/<filename-without-extension>/`:

```yaml
---
title: "Project title"
summary: "2–3 sentences about what you did and the outcome."
period: "2023 – present"
stack: ["aws", "terraform", "python"]
metric:
  value: "$1M saved"
  label: "Annual spend"
order: 1       # lower numbers appear first
featured: true # shows on the home page when metric is also present
---
```

## Editing the home page

Most of the top content is driven by `src/config.ts`:

```ts
export const site = {
  currently: 'new enterprise AI team, week 1',
  // ...
};
```

The headline and lede live directly in `src/pages/index.astro`. The "Recent writing" section pulls from published posts, and the "Selected work" grid pulls from project entries marked `featured: true` with a `metric`.

## Editing About

`src/pages/about.astro`. Straight MDX-like content. Certs are a small array at the top.

## Theme / visual tweaks

All design tokens (palette, fonts, radii) are in `src/styles/global.css` inside the `@theme` block. Change the accent color once and the whole site updates.

Fonts are self-hosted through Astro's Fonts API (`fonts` in `astro.config.mjs`) from pinned
`@fontsource` packages: Instrument Serif (regular and italic), Inter (400, 500 and 600 from one
variable file) and JetBrains Mono (400 and 500). The browser makes no third-party requests; the egress
checks fail the build if a page, stylesheet or script reaches another host. Don't add weights without
a reason, it hurts LCP.

## Agent corpus and evals

Every `astro build` writes `generated/corpus.json` (not committed) for the planned site agent (#13).
It is extracted from the built project pages, published essays and `/resume/`, split into one entry
per section, and every entry carries a stable ID (`project/team-brain#the-problem`) and the
repository file it came from. Drafts are excluded. `evals/question-set.json` is the agent's eval
question set; see `evals/README.md`.

## Accessibility notes

- `prefers-reduced-motion` kills the pulsing dot and view transitions.
- Every link has a hover state that isn't just color.
- Theme toggle is a real button with `aria-label`.
- Color contrast passes WCAG AA in both themes.

## Content TODOs before going public

- [ ] Change the pill text in `src/config.ts` when your "currently" status changes.
- [ ] Flip the starter post's `draft: true` to `false` when you're ready.
- [ ] Drop your real LinkedIn URL in `src/config.ts` if the handle there isn't right.
- [ ] Sanity-check the About page for anything you'd rather not make public.

## Stack choices, briefly

- **Astro** over Next: content-first, zero JS by default, MDX is first-class.
- **Tailwind v4** over hand-CSS: faster iteration, no runtime cost.
- **HashRouter-less**: Astro is fully static, so every page is a real HTML file that Workers static assets serve directly — no 404-on-refresh hacks needed.
- **View Transitions API** via Astro's `<ClientRouter />`: smooth page transitions without shipping a SPA.

### Downloadable résumé

`src/data/resume.json` supplies the `/resume/` page and the downloadable PDF.
After editing it, regenerate `public/mitchell-knoth-resume.pdf` with
`python3 scripts/build-resume.py` (requires ReportLab), inspect the PDF, and commit
both source and output. Normal site builds use the committed PDF.
