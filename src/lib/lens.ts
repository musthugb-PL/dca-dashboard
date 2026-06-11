/**
 * Lens score → traffic-light dot class (PL semantic tokens via dca.css).
 * Per CLAUDE.md "Signal colors":
 *   <30  → green (no concern)   30–60 → yellow (contributing)   >60 → red (primary)
 * null/undefined → grey (not yet evaluated — all dots until P2.2 fills scores).
 */
export function lensDotClass(score: number | null | undefined): string {
  if (score == null) return "dca-lens-dot--grey";
  if (score < 30) return "dca-lens-dot--green";
  if (score <= 60) return "dca-lens-dot--yellow";
  return "dca-lens-dot--red";
}

export const LENS_NAMES = [
  "Internal",
  "Meta",
  "Google",
  "GA4",
  "Last week",
  "Market",
] as const;
