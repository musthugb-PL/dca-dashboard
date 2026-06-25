/** Shared AI-brain output types (P2.2). */

export type Severity = "green" | "yellow" | "red";
export type Confidence = "high" | "medium" | "low";
export type LensName = "internal" | "meta" | "google" | "ga4" | "last_week" | "market";
export type Action = "KILL" | "PAUSE" | "OPTIMIZE" | "SCALE" | "REMARKET" | "HOLD";

export const LENS_ORDER: LensName[] = ["internal", "meta", "google", "ga4", "last_week", "market"];

export type LensOutput = {
  lens: LensName;
  lens_score: number; // 0-100
  severity: Severity;
  diagnosis_bullets: string[]; // 2-3 atomic, cited
  cluster_benchmark_used: string; // named benchmark or "none available"
  analog_event_cited: string; // named analog + metric, or "none available"
  confidence: Confidence;
};

export type TacticalStep = { id: number; text: string; channel: string };

export type Verdict = {
  primary_lens: LensName | null;
  contributing_lenses: LensName[];
  recommended_action: Action;
  tactical_steps: TacticalStep[];
  strategic_context: string;
  expected_outcome_template: string;
  /** AI-suggested options for the approver's "expected outcome" dropdown (B4).
   *  Optional — absent on analyses persisted before Phase B; UI falls back. */
  expected_outcome_options?: string[];
  confidence: Confidence;
};

export type BrainAnalysis = {
  event_id: number;
  generated_at: string;
  lenses: LensOutput[];
  verdict: Verdict;
};
