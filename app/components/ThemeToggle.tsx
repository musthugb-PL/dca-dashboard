"use client";

import { useEffect, useState } from "react";

/**
 * Light/Dark theme toggle — flips data-theme on <html> and persists it.
 *
 * Uses a text label rather than a sun/moon glyph: the PL design-system icon
 * set isn't vendored in this plugin checkout, and the DS rule forbids ad-hoc
 * SVGs / emoji as iconography. Swap in the canonical sun/moon icons once the
 * icon assets are vendored from the design-system repo.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    // Default to dark — matches the team's existing Marketing Insights dashboards.
    const stored = (localStorage.getItem("dca-theme") as "light" | "dark" | null) ?? null;
    setTheme(stored ?? "dark");
  }, []);

  function flip() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("dca-theme", next);
    } catch {
      /* ignore */
    }
  }

  const label = theme === "dark" ? "Light mode" : "Dark mode";

  return (
    <button
      type="button"
      className="pl-btn pl-btn-secondary pl-btn-s"
      onClick={flip}
      aria-label={`Switch to ${label}`}
      suppressHydrationWarning
    >
      {theme ? label : "Theme"}
    </button>
  );
}
