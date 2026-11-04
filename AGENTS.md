# Repository Agent Instructions

## Article Writing Harness

> [!IMPORTANT]
> For article work in `src/content/posts/`, Mitch Knoth is the canonical authorial voice. Use the published essays as the primary style reference. The writing vault is optional, task-triggered context—not a mandatory checklist.

### Context routing

- First read the most relevant published essay in `src/content/posts/`. Read both only when the task depends on patterns from both.
- For a substantial new draft or rewrite, also read `writing-vault/Mitch Knoth Writing Persona.md`.
- Load at most one named editorial lens when it materially fits the task:
  - `writing-vault/Martin Fowler Editorial Lens.md` for definitions, distinctions, examples, or evolutionary design.
  - `writing-vault/Gene Kim Editorial Lens.md` for systems, flow, feedback, learning, or customer value.
  - `writing-vault/Jensen Huang Editorial Lens.md` for first principles, platform framing, strategic stakes, or compression.
- Load `writing-vault/Writing Persona Source Ledger.md` only when attributing an idea or adding an external factual claim.
- Use `writing-vault/Essay Brief Template.md` or `writing-vault/Editorial Council.md` only when the user explicitly asks for a brief, a multi-lens review, or the full editorial workflow.

### Writing rules

- Draft and synthesize in Mitch's voice. Never write “as” a named public figure or reproduce distinctive phrases, cadence, anecdotes, or verbal tics.
- Treat a named-person lens as private editorial scaffolding. Rewrite any useful insight in Mitch's vocabulary.
- Begin with an operational tension when it improves the argument. Prefer one dominant model, one inspectable example, explicit evidence boundaries, and a practical next move; do not force this structure when the subject needs another shape.
- Separate facts, observations, inferences, recommendations, authority, and completion status. Do not let a source support a stronger claim than it actually establishes.
- Prefer primary sources for important factual claims.
- Protect private context. Do not publish employer, customer, team, individual, internal metric, or Microsoft Teams details without explicit publication authority.
- Never repeat a private identifier merely to explain that it was removed.
- Return only the artifact and reporting the user requested. Do not expose persona names, lens selection, blend percentages, evidence-spine bookkeeping, privacy checklists, or validation narration in article prose or outlines unless explicitly requested.
- When source files change, run `npm run check`, `npm run build`, and `git diff --check`, then report those results outside the article artifact.

## Visual Quality Harness

Treat the site as an editorial system, not a collection of independently styled pages. Any layout,
component, typography, or MDX presentation change must preserve these standards:

- Audit the rendered site in a real, headed browser. Use `npm run test:visual:headed` for critique;
  DOM measurements support the visual review but do not replace it.
- Exercise the canonical viewport matrix: 320px phone, 768px tablet, 1440px desktop, and 3440px
  ultrawide. Check both dark and light themes when changing color, borders, or elevation.
- Keep the responsive shell fluid through 1440px with fluid gutters. Do not reintroduce a narrow
  fixed-width site shell; long-form prose may keep a readable measure inside the wider shell.
- Preserve a visible heading hierarchy. Semantic section headings must read as headings and must not
  be smaller than body copy; mono uppercase text is metadata, not a substitute for hierarchy.
- Do not render long prose lists as browser-default indentation or unmarked stacked paragraphs.
  Use the shared editorial list treatment or a purpose-built diagram, matrix, sequence, or field card.
- Do not manufacture hierarchy with a detached dash, dot, number, or other pseudo-element on its own
  line above every list item. A marker must carry semantic information and stay visually attached to
  its item; when a grid, card boundary, or grouping already establishes the items, omit the marker.
- Do not turn a short list into a spec sheet by putting a rule above or below every row. Group related
  items, use a compact grid, or reserve dividers for meaningful section boundaries.
- Full-width components must earn their width. A bordered panel containing one readable-width column
  plus a large empty remainder is not responsive; it is an under-composed component. On wide screens,
  either constrain the component to its content measure or use the additional width for a deliberate
  second column, media, metadata, or another useful relationship.
- Treat whitespace as part of the composition, not as leftover viewport area. Fluid shells may grow,
  but sparse child components still need content-aware max widths or responsive internal layouts.
- Use section-specific imagery to reset attention in long-form essays. A published essay should have
  at least two meaningful visuals when its length creates sustained text density; longer essays may
  use a third visual when it marks a distinct turn in the argument.
- Every editorial image must explain a relationship, boundary, sequence, or operating model already
  present in the prose. Do not add generic technology decoration, fake interface screenshots, or an
  image whose meaning depends on text rendered inside the bitmap.
- Place each visual adjacent to the claim it clarifies, give it descriptive alt text, declare intrinsic
  dimensions to prevent layout shift, eagerly load only the first article image, and lazy-load later
  images. Keep a coherent visual language within an essay series instead of mixing unrelated styles.
- Section labels must describe the content's present relationship to the page. Reserve “Archive” for
  an intentionally historical or inactive corpus; use “More writing” for current posts listed beneath
  a featured essay.
- Prevent header collisions, horizontal overflow, escaped figures, and narrow tabbed columns at every
  canonical viewport. Mobile archive and workflow content should stack with a shared left edge.
- Keep touch targets usable and honor reduced-motion preferences.

During headed review, explicitly reject these render signatures:

- orphaned decorative glyphs that look like broken bullets;
- repeated hairline rows that make prose or credentials resemble an unstyled data table;
- a card or bordered region whose visible content occupies only one side at desktop or ultrawide sizes;
- large internal voids created by applying `width: 100%` without redesigning the component's contents.

Before publishing any source change, run `npm run quality` and `git diff --check`. GitHub Pages runs
the same Playwright visual contract before deployment, so a visual regression must fail the build.
