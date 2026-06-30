/** Shared AI-brain output types (P2.2). */

export type Severity = "green" | "yellow" | "red" | "neutral";
export type Confidence = "high" | "medium" | "low";
export type LensName = "internal" | "meta" | "google" | "ga4" | "last_week" | "market";
export type Action = "KILL" | "PAUSE" | "OPTIMIZE" | "SCALE" | "REMARKET" | "HOLD";

export const LENS_ORDER: LensName[] = ["internal", "meta", "google", "ga4", "last_week", "market"];

export type LensOutput = {
  lens: LensName;
  lens_score: number | null; // 0-100, or null = no data (honest "No data yet")
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
  /** STEP 3 FIX M — data signal too weak to confidently automate an action;
   *  UI shows a "Strategist review required" banner. Optional — absent on
   *  analyses persisted before STEP 3 (UI falls back to step-text detection). */
  manual_review_required?: boolean;
};

export type BrainAnalysis = {
  event_id: number;
  generated_at: string;
  lenses: LensOutput[];
  verdict: Verdict;
};
