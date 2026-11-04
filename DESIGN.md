---
version: alpha
name: Mitchell Knoth — Engineering Field Journal
description: Editorial design contract for the engineering field journal.
colors:
  primary: "#f4eee1"
  dark-bg: "#0c0a08"
  dark-surface: "#14110d"
  dark-muted: "#a39785"
  dark-meta: "#8a7d68"
  dark-accent: "#c8973a"
  light-bg: "#fbf8f1"
  light-surface: "#ffffff"
  light-ink: "#1a1410"
  light-muted: "#5b5244"
  light-meta: "#766a57"
  light-accent: "#866214"
typography:
  display: { fontFamily: 'Instrument Serif, Georgia, serif', fontSize: 56px, fontWeight: 400, lineHeight: 1.08, letterSpacing: -0.015em }
  section: { fontFamily: 'Instrument Serif, Georgia, serif', fontSize: 32px, fontWeight: 400, lineHeight: 1.2 }
  subsection: { fontFamily: 'Inter, sans-serif', fontSize: 22px, fontWeight: 600, lineHeight: 1.35 }
  body: { fontFamily: 'Inter, sans-serif', fontSize: 17px, fontWeight: 400, lineHeight: 1.7 }
  small: { fontFamily: 'Inter, sans-serif', fontSize: 14px, fontWeight: 400, lineHeight: 1.6 }
  meta: { fontFamily: 'JetBrains Mono, monospace', fontSize: 12px, fontWeight: 400, lineHeight: 1.5, letterSpacing: 0.06em }
rounded:
  tag: 3px
  panel: 6px
  control: 8px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  section: 48px
  chapter: 64px
  hero: 96px
components:
  page-dark: { backgroundColor: '{colors.dark-bg}', textColor: '{colors.primary}', typography: '{typography.body}' }
  page-light: { backgroundColor: '{colors.light-bg}', textColor: '{colors.light-ink}', typography: '{typography.body}' }
  panel-dark: { backgroundColor: '{colors.dark-surface}', textColor: '{colors.dark-muted}', rounded: '{rounded.panel}', padding: '{spacing.xl}' }
  panel-light: { backgroundColor: '{colors.light-surface}', textColor: '{colors.light-muted}', rounded: '{rounded.panel}', padding: '{spacing.xl}' }
  metadata-dark: { backgroundColor: '{colors.dark-bg}', textColor: '{colors.dark-meta}', typography: '{typography.meta}' }
  metadata-light: { backgroundColor: '{colors.light-bg}', textColor: '{colors.light-meta}', typography: '{typography.meta}' }
  link-dark: { backgroundColor: '{colors.dark-bg}', textColor: '{colors.dark-accent}', typography: '{typography.small}' }
  link-light: { backgroundColor: '{colors.light-bg}', textColor: '{colors.light-accent}', typography: '{typography.small}' }
  control: { height: 44px, rounded: '{rounded.control}', padding: '{spacing.md}' }
---

# DESIGN.md — Editorial Contract

## Overview

An engineering field journal: warm, precise, personal, and inspectable. The reader should understand what Mitch builds, find a credible example, and read without visual friction. Preserve the established operational tensions, concrete examples, explicit evidence boundaries, and practical next moves. Do not replace the author's voice with agency slogans or inflated performance claims.

This contract guides implementation; rendered review and regression checks verify its application. In Agent = Model + Harness terms, this file supplies design guides/feedforward; browser review, accessibility checks, and CI supply sensors/feedback. Capture repeated visual misses as durable rules and regression checks rather than adding a new exception per page.

## Colors

Use two equally finished themes. Map semantic `bg`, `surface`, `fg`, `muted`, `meta`, and `accent` to the corresponding dark/light tokens above; `primary` is dark-theme foreground, not a universal foreground. Structural rules use #706654 in dark and #91856d in light. Focus uses the accent token. These non-text roles are specified here because the alpha component schema does not expose border/outline-color roles. Respect saved theme choice, otherwise system preference. Prevent a flash of the wrong theme. Expose the current theme through an accessible control label or state.

Amber identifies links, intentional emphasis, and focus—not every label or border. Text links retain an underline or another persistent non-color affordance. Hover changes underline thickness or uses a tested foreground token; never dim small link text using opacity. Ordinary panels may use quieter decorative borders, but essential boundaries and focus indicators must meet 3:1 against their adjacent backgrounds. Body, metadata, captions, and all link states must meet 4.5:1; large display text at least 3:1. Test composited colors, not just raw token pairs.

## Typography

Keep Instrument Serif for display/editorial titles, Inter for reading/interface text, and JetBrains Mono only for short metadata, dates, status, and code. Use explicit fallbacks and only loaded weights. Never use uppercase mono as a semantic section heading.

- H1: `clamp(2.5rem, 4vw, 3.5rem)`, line-height 1.08; one H1 per page. Long essay titles may reach 3.45rem but must wrap naturally at 320px without clipping or forced desktop line breaks.
- H2: `clamp(1.6rem, 2.2vw, 2rem)`, serif, line-height 1.2. H3: 1.375rem Inter semibold, line-height 1.35. All genuine H2/H3 labels remain at least 20px, including inside figures, navigation, and asides.
- Body: 17px / 1.7; supporting text 14px / 1.6; metadata 12px / 1.5. Do not reduce prose below 16px to make a layout fit.
- Reading measure: 68ch target, 72ch maximum; lead copy 55–60ch. Card summaries 35–55ch. Typography scales independently of the shell.

## Layout

### Geometry and spacing

Keep the fluid editorial shell: `width:100%`, border-box, `max-width:90rem`, centered, with `clamp(1rem,4vw,4rem)` inline gutters. It grows through 1440px and stops at 1440px on ultrawide screens. Outer ultrawide margins are intentional; empty space *inside* a full-width bordered panel is not.

Use the spacing scale, with 32px and 96px available for deliberate intermediate/hero relationships. Paragraph separation 20–24px; heading-to-copy 12–16px; component padding 16px phone / 24–32px wide; section gaps 40–48px phone / 64px wide. Avoid doubling section padding and child margins at the same boundary.

Give each component an explicit width class: `reading` (68–72ch), `diagram` (max 62rem), or `shell` (90rem). Do not expand every article nav/aside/figure with one selector. A short related-reading card stays at reading width; a diagram may expand because it explains a relationship. A shell-width panel requires two useful columns or meaningful media; otherwise constrain it.

### Responsive composition

- Under 768px: one column; consistent left edge for navigation, lists, dates, figures, and workflow steps. Below 360px, retain the two-row header with brand and theme control above navigation. No compressed tabbed columns.
- 768–1023px: two columns only where labels and prose remain legible; allow long headlines and tags to wrap. No fixed card heights that clip content.
- 1024–1439px: deliberate 12-column composition; hero may use 7/5, fact grids 2–3 columns, diagram comparisons 2–3. Reading copy does not inherit the shell width.
- 1440px and above: shell remains capped; figures max 992px; long prose max 72ch. Use additional *internal* width for relationships, not blank card acreage. No full-screen stretching at 3440px.

### Page recipes

- Home: one positioning claim, a concise lead, two clear routes to Work/Experience, then three linked proof cards and featured writing. At 320×844 the primary route must remain visible; trim duplication before shrinking type. At desktop, pair the readable lead with a restrained original operating-model plate or compact evidence index if it adds meaning. No decorative dashboard or generic AI hero art.
- About: short human introduction, a compact 2–3-column fact grid, then current practice and chronological chapters. Keep six facts out of six full-width ruled rows. Group skills into three understandable capabilities with supporting detail; do not make credentials a wall of equally prominent boxes.
- Work: short lede, clear recent/foundations groupings, one featured case and a restrained case index. Target first case title at or above 700px from document top at 320×844. Each item shows project, contribution, outcome/status, and a link; technologies are secondary. No invented metric for a capability or completion state.
- Case studies: title, readable one-sentence summary, compact context/contribution/result/evidence-boundary facts, then problem → decision → implementation/checks → result. Put one public-safe diagram adjacent to a real architectural tradeoff when useful. Do not require an illustration for a short case that needs none.
- Writing: maintain the strong two-column featured essay at desktop and stack at phone. Give other essays a title, complete date, and one-sentence reader benefit; use a compact grouped index rather than stretching two sparse ruled rows across the entire shell. Keep the label “More writing.”
- Essays: argument-led opening, compact TOC after orientation, readable body, meaningful visual resets, source notes, related reading. Align figures with the claims they clarify. Article components vary by purpose but use the same type, spacing, palette, and width grammar.
- Experience/résumé: use the reading measure, concise summary, visible download action, chronological entries, and attached semantic bullets. Match the shared header/footer and heading hierarchy. The PDF is a separate medium requiring its own print/readability review.

## Elevation & Depth

Most content is flat on the page. Use one subtle surface level for a featured essay or field card, not a different shadow for every component. Editorial images use a restrained border without a decorative drop shadow. Borders mark meaningful boundaries. Avoid glossy tiles, floating dashboard panels, backdrop blur, and heavy image shadows that compete with the prose.

## Shapes

Use 3px tag corners, 6px panel/image corners, 8px controls. Reserve pills for a short status—not paragraphs or every section label. Rectilinear diagrams fit the engineering vocabulary; no arbitrary blob decoration.

## Components

### Navigation and interaction

Header/footer controls and standalone links have at least 44×44px hit regions independent of pointer classification. Inline prose links are exempt from that layout rule but remain distinguishable and spaced. Preserve the skip link; keyboard focus is visible, never clipped or hidden by sticky UI. Focus outline: 2px, offset 3px, contrast at least 3:1. Identify the active navigation route with `aria-current`. Provide a non-hover path for every action. Do not add a sticky header without checking anchors and focus at every viewport.

### Editorial lists and panels

Use semantic ul/ol/dl. Markers carry real list/order meaning and stay attached to their item. Never place a detached pseudo-element glyph above an item; omit markers when a card/grid already groups items. Avoid a hairline above and below every short row. Reserve dividers for chapter boundaries, or a real comparison where the rules aid scanning. TOC links use a compact two-column index when there is room, one column on phone; no border around a wide, single narrow column. Field cards group related actions rather than mechanically ruling every sentence. Heading rules apply inside all components.

### Imagery

Preserve the essay series' coherent mechanical/amber visual language. Each image explains a relationship, boundary, sequence, or operating model already in the prose. A sustained long essay has at least two meaningful visual resets; use a third only for a distinct argumentative turn. Do not add generic technology decoration, fake product UI, or information that depends on words baked into a bitmap.

Provide descriptive alt text, intrinsic width/height, and an HTML caption when the metaphor needs a noun-to-object mapping. Eager-load only the first editorial image; lazy-load later ones. On narrow screens simplify the relationship or provide an equivalent HTML explanation instead of making tiny raster details essential. Preserve aspect ratio, constrain to the selected width class, and verify actual lazy loading by scrolling before judging a full-page capture.

### Motion and accessibility

The Home portrait is static. Motion is optional feedback, not ambiance. Limit nonessential transitions to 120–180ms; no infinite pulse, parallax, scroll hijacking, or animation-driven navigation. Under `prefers-reduced-motion:reduce`, remove nonessential animations/transitions and use instant anchor scrolling. Theme/navigation must remain functional with motion disabled.

Target WCAG 2.2 AA. Verify keyboard navigation, visible focus, semantic order, explicit control names/states, zoom/reflow at 200%, text spacing overrides, contrast in default/hover/focus/active states, meaningful alternatives for visuals, and no color-only status. Do not claim compliance from token lint or a handful of DOM assertions.

## Do's and Don'ts

- Do retain the author's direct voice and explicit distinctions among delivery, experiment, observation, inference, and recommendation. Keep unpublished identities and internal evidence out of public visuals and examples.
- Do prefer stable shared primitives over per-page exceptions. A new component must declare its width class, type roles, theme mapping, responsive stacking, and motion behavior.
- Don't trade readable measures for more columns, put metadata in a heading tag, or interpret an empty full-width panel as “premium whitespace.”
- Don't adopt a generic SaaS bento layout, fluorescent palette, decorative dashboard, or animation framework without a demonstrable reader benefit.
- Before publication, run `npm run quality` and `git diff --check`; perform `npm run test:visual:headed` critique at 320×844, 768×1024, 1440×1000, and 3440×1440 in both themes, plus reduced motion and coarse/fine pointers. Reject clipped headings, overflow, detached glyphs, repetitive hairline rows, escaped figures, one-sided panels, and excessive internal voids.
- Add explicit checks for contrast states, 44px standalone targets, heading hierarchy inside editorial components, and nonempty Work groups. Keep a human visual-review checkpoint: geometry passing does not prove composition is good.
- Pin the DESIGN.md CLI/version if adopted; lint tokens and review exported CSS diffs. Keep themes, responsiveness, imagery, and motion in prose until the alpha schema supports them explicitly. Exporting tokens does not implement this contract.
