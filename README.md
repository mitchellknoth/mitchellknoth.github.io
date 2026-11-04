# mitchellknoth.com

Personal site. Astro 6 + Tailwind v4 + MDX, dark-first with a light mode toggle. Deployed to GitHub Pages via Actions.

## Quick start

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # production build → ./dist
npm run preview    # preview the built site
npm run quality    # type/build checks + responsive Playwright contract
```

For visual critique, run `npm run test:visual:headed`. The suite opens Chromium and exercises every
public route at phone, tablet, desktop, and ultrawide viewports. Failed checks retain a screenshot and
trace in `test-results/`; CI runs the same contract before GitHub Pages can deploy.

## Deploying to GitHub Pages

This is a **user site** deployed through GitHub Pages and served at `https://mitchellknoth.com`. Cloudflare manages registration and DNS.

1. Make sure the repo is named exactly `mknoth197.github.io` and is **public**.
2. Repo → **Settings → Pages → Source → "GitHub Actions"**.
3. Push to `main`. The workflow at `.github/workflows/deploy.yml` builds and publishes.

First deploy takes ~1 minute. Subsequent deploys are incremental and usually under 30 seconds.

### Custom domain

- GitHub repository **Settings → Pages → Custom domain**: `mitchellknoth.com`. The GitHub Actions publishing source uses this setting; a `CNAME` file is not required.
- Cloudflare DNS: four DNS-only `A` records for `@`, pointing to `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, and `185.199.111.153`.
- Cloudflare DNS: a DNS-only `CNAME` record for `www`, pointing to `mknoth197.github.io`. GitHub redirects this alias to the apex domain.
- Enable **Enforce HTTPS** in GitHub Pages once the custom-domain certificate is issued.
- `SITE` in `astro.config.mjs` is the public origin for canonical URLs, RSS, and the sitemap. Update it if the public domain changes.

The repository name and profile link in `src/config.ts` do not change when the public domain changes. No Wrangler deployment is needed for this DNS connection.

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

Two weights of Instrument Serif and three weights of Inter are loaded — don't add more without a reason, it hurts LCP.

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
- **HashRouter-less**: Astro is fully static, so every page is a real HTML file that GitHub Pages serves directly — no 404-on-refresh hacks needed.
- **View Transitions API** via Astro's `<ClientRouter />`: smooth page transitions without shipping a SPA.

### Downloadable résumé

`src/data/resume.json` supplies the `/resume/` page and the downloadable PDF.
After editing it, regenerate `public/mitchell-knoth-resume.pdf` with
`python3 scripts/build-resume.py` (requires ReportLab), inspect the PDF, and commit
both source and output. Normal site builds use the committed PDF.
