import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"

type Theme = "dark" | "light"

const current = (): Theme => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark")

function applyTheme(next: Theme) {
  document.documentElement.setAttribute("data-theme", next)
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#fbf8f1" : "#0c0a08")
  try {
    localStorage.setItem("theme", next)
  } catch {
    // Private windows and blocked storage: the theme still switches for this page.
  }
}

/**
 * The theme switch. The first script in <head> (Base.astro) sets `data-theme` before paint, so the icon is
 * chosen by CSS from that attribute and the server HTML is right for either theme; only the accessible name
 * waits for the client, because it has to say which way the click goes.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = React.useState<Theme>("dark")
  React.useEffect(() => setTheme(current()), [])

  function toggle() {
    const next: Theme = current() === "light" ? "dark" : "light"
    // A theme switch is rare, so it may be seen: one short crossfade of the page (the 180ms root fade the page
    // navigations use, in global.css). With reduced motion, or without view transitions, it is a single frame.
    const update = () => {
      applyTheme(next)
      setTheme(next)
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduce || !document.startViewTransition) update()
    else document.startViewTransition(update)
  }

  return (
    <Button
      id="theme-toggle"
      variant="outline"
      size="icon"
      className="size-11 text-muted-foreground"
      data-site="theme-toggle"
      aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
      onClick={toggle}
    >
      <Moon aria-hidden="true" className="hidden dark:block" />
      <Sun aria-hidden="true" className="block dark:hidden" />
    </Button>
  )
}
