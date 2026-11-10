/**
 * How the site's own links and nav controls are styled: shadcn's `buttonVariants`, plus the few DESIGN.md
 * adjustments, in one place. Templates spread `link`, `nav`, `footerLink` or `brand`; nothing here is a new
 * component, and `src/components/ui/button.tsx` stays as the CLI wrote it.
 *
 * `data-slot="button"` is what the token layer in src/styles/agent-theme.css keys on (one focus outline, no
 * outline animation), and `data-site` names the role for tests.
 *
 * Every standalone control is at least 44x44px (DESIGN.md › Navigation and interaction).
 */
import { cn } from "cn"
import { buttonVariants } from "@/components/ui/button"

const touch = "min-h-11 min-w-11"

/** An inline call to action: "Explore my work →". Amber, underlined, 14px. */
export const linkClass = cn(
  buttonVariants({ variant: "link" }),
  touch,
  "h-auto px-0 font-normal whitespace-normal underline underline-offset-4",
)

/** A primary navigation item; the current page is amber (aria-current). */
export const navClass = cn(
  buttonVariants({ variant: "ghost" }),
  touch,
  "h-11 px-3 text-[13.5px] font-normal text-muted-foreground hover:text-foreground aria-[current=page]:text-accent",
)

/** A footer link: mono, quiet. */
export const footerLinkClass = cn(
  buttonVariants({ variant: "ghost" }),
  touch,
  "h-11 px-3 font-mono text-xs font-normal text-(--fg-dim) hover:text-foreground",
)

/** The site name, a link to home. */
export const brandClass = cn(
  buttonVariants({ variant: "link" }),
  touch,
  "prose-serif h-11 justify-start px-0 text-[17px] tracking-tight text-foreground",
)

/** A heading that is itself a link (card and list titles): inherits the heading's type, 44px tall. */
export const titleLinkClass = "inline-flex min-h-11 items-center underline-offset-4 hover:underline"

/**
 * A card that is one link: the title link stretches over the whole card (one tab stop, one accessible name),
 * the border steps up on hover for pointers that can hover, and keyboard focus outlines the card, not just the
 * title. Apply `cardLinkClass` to the Card and `stretchedLinkClass` to the title's <a>. The card-level states
 * live in src/styles/agent-theme.css (`.card-link`): that file's Card border is unlayered, so a Tailwind hover
 * utility here would lose to it.
 */
export const stretchedLinkClass = cn(titleLinkClass, "after:absolute after:inset-0 after:content-[''] focus-visible:outline-none")
export const cardLinkClass = "card-link"

/** A technology or status label (Badge variant="outline"): 3px, mono, quiet. */
export const tagClass = "h-auto rounded-[3px] border-(--border-strong) bg-transparent px-1.5 py-0.5 font-mono text-xs font-normal text-(--fg-dim)"

export const linkProps = { class: linkClass, "data-slot": "button", "data-site": "link" } as const
export const navProps = { class: navClass, "data-slot": "button", "data-site": "nav" } as const
export const footerLinkProps = { class: footerLinkClass, "data-slot": "button", "data-site": "footer" } as const
export const brandProps = { class: brandClass, "data-slot": "button", "data-site": "brand" } as const
