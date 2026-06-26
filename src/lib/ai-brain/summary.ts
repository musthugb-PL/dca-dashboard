/**
 * Pure helpers to derive the dashboard card's one-line AI summary from a
 * BrainAnalysis. Shared so the card and report stay consistent.
 */

import type { BrainAnalysis, LensName, LensOutput } from "./types";

/** The lens whose diagnosis best explains the verdict: primary if set, else the
 *  first contributing lens with bullets, else the highest-scoring lens. */
export function leadingLens(analysis: BrainAnalysis): LensOutput | null {
  const { lenses, verdict } = analysis;
  if (!lenses?.length) return null;
  const byKey = (k: LensName | null) => (k ? lenses.find((l) => l.lens === k) : undefined);

  const primary = byKey(verdict.primary_lens);
  if (primary && primary.diagnosis_bullets.length) return primary;

  for (const k of verdict.contributing_lenses) {
    const l = byKey(k);
    if (l && l.diagnosis_bullets.length) return l;
  }
  const withBullets = lenses.filter((l) => l.diagnosis_bullets.length);
  if (withBullets.length) {
    return withBullets.reduce((a, b) => ((b.lens_score ?? -1) > (a.lens_score ?? -1) ? b : a));
  }
  return primary ?? lenses[0] ?? null;
}

/** One-line reason for the card: the leading lens's first diagnosis bullet. */
export function cardReason(analysis: BrainAnalysis): string | null {
  const lens = leadingLens(analysis);
  return lens?.diagnosis_bullets[0] ?? null;
}
