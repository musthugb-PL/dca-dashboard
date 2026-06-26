"use client";

/**
 * Phase B2 + B4: the interactive decision surface for the report page.
 * - Sticky header (B2): verb + primary/contributing + confidence + risk +
 *   step counts + "Approve All" / "Review Step by Step ↓".
 * - Per-step Approve/Override (B4): each tactical step approvable or
 *   overridable (reason dropdown + notes), a Manual-Review banner, an
 *   AI-suggested "expected outcome" dropdown, and Submit Decision → /api/decisions.
 * Shared approve-state lives here so the header counts and the verdict stay in sync.
 *
 * Server-rendered lens sections are passed as `children` and rendered between
 * the sticky header and the verdict.
 */

import { useMemo, useRef, useState } from "react";
import type { Verdict, LensName } from "@/src/lib/ai-brain/types";

const LENS_LABEL: Record<LensName, string> = {
  internal: "Internal", meta: "Meta", google: "Google", ga4: "GA4", last_week: "Last week", market: "Market",
};

const OVERRIDE_REASONS = [
  "Cost too risky mid-campaign",
  "Wrong audience read",
  "Missed market context",
  "Agency rule conflict",
  "Step is too aggressive",
  "Step is not aggressive enough",
  "Other",
];

const ACTIONS = ["HOLD", "OPTIMIZE", "SCALE", "PAUSE", "KILL", "REMARKET"] as const;

/** Per-verb personality: glyph + tone line + colour class (readable across a room). */
const VERB_META: Record<string, { glyph: string; tone: string; cls: string }> = {
  HOLD: { glyph: "✓", tone: "Healthy — keep going", cls: "good" },
  SCALE: { glyph: "↗", tone: "Winning — push more", cls: "good" },
  OPTIMIZE: { glyph: "⚙", tone: "Needs tuning", cls: "warn" },
  PAUSE: { glyph: "⏸", tone: "Stop spending", cls: "orange" },
  KILL: { glyph: "✕", tone: "End it", cls: "bad" },
  REMARKET: { glyph: "⟳", tone: "Re-engage", cls: "pro" },
};
const isContinueStep = (text: string) => /no (within-event )?(optimization|action|changes?) (needed|required)|continue current allocation/i.test(text);

const DEFAULT_OUTCOMES = [
  "Meta CPA drops below AED 50 within 5 days",
  "Google conversions increase 30%+ within 7 days",
  "ROAS reaches 1.5× the cluster baseline",
  "Ticket sales accelerate 20%+ this week",
  "Meta frequency drops below 2× within a week",
];

const isManualReview = (text: string) => /manual review required|escalate to (a )?human|escalate to (the )?(commercial|strategist)/i.test(text);

type StepStatus = "pending" | "approved" | "dismissed";

export default function DecisionFlow({
  verdict,
  eventId,
  slot,
  children,
}: {
  verdict: Verdict | null;
  eventId: string;
  slot: number | null;
  children: React.ReactNode;
}) {
  const steps = verdict?.tactical_steps ?? [];
  const verdictRef = useRef<HTMLDivElement>(null);

  const [status, setStatus] = useState<Record<number, StepStatus>>({});
  const [overrides, setOverrides] = useState<Record<number, { reason: string; notes: string }>>({});
  const [openOverride, setOpenOverride] = useState<number | null>(null);
  const [finalAction, setFinalAction] = useState<string>(verdict?.recommended_action ?? "HOLD");
  const [outcomeSel, setOutcomeSel] = useState<string>("");
  const [outcomeCustom, setOutcomeCustom] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const counts = useMemo(() => {
    let approved = 0, dismissed = 0;
    for (const s of steps) {
      const st = status[s.id] ?? "pending";
      if (st === "approved") approved++;
      else if (st === "dismissed") dismissed++;
    }
    return { total: steps.length, approved, dismissed, pending: steps.length - approved - dismissed };
  }, [steps, status]);

  const manualReviewSteps = steps.filter((s) => isManualReview(s.text));
  const outcomeOptions = verdict?.expected_outcome_options?.length ? verdict.expected_outcome_options : DEFAULT_OUTCOMES;
  const expectedOutcome = outcomeSel === "__custom__" ? outcomeCustom.trim() : outcomeSel;
  const canSubmit = !!verdict && expectedOutcome.length > 0 && !submitting && !submitted;

  const scrollToVerdict = () => verdictRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  const approveAll = () => setStatus(Object.fromEntries(steps.map((s) => [s.id, "approved" as StepStatus])));
  const setStep = (id: number, st: StepStatus) => setStatus((p) => ({ ...p, [id]: st }));

  async function submit() {
    if (!canSubmit || !verdict) return;
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch("/api/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: eventId,
          slot,
          ai_recommended_action: verdict.recommended_action,
          user_approved_action: finalAction,
          approved_steps: steps.filter((s) => (status[s.id] ?? "pending") === "approved").map((s) => s.id),
          dismissed_steps: steps
            .filter((s) => (status[s.id] ?? "pending") === "dismissed")
            .map((s) => ({ step_id: s.id, reason: overrides[s.id]?.reason ?? "Other", notes: overrides[s.id]?.notes ?? "" })),
          manual_review_required: manualReviewSteps.length > 0,
          expected_outcome: expectedOutcome,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setSubmitted(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const verb = verdict?.recommended_action ?? "—";
  const vm = VERB_META[verb] ?? { glyph: "○", tone: "Not analysed", cls: "neutral" };
  const celebratory = verb === "HOLD" || verb === "SCALE";
  const lensLine = verdict
    ? `${verdict.primary_lens ? `Primary: ${LENS_LABEL[verdict.primary_lens]}` : "No single primary lens"}` +
      (verdict.contributing_lenses.length ? ` · Contributing: ${verdict.contributing_lenses.map((k) => LENS_LABEL[k]).join(", ")}` : "")
    : "Not analysed yet";

  return (
    <>
      {/* B2 + Fix 16 — sticky decision header, coloured by verb */}
      <div className={`dca-sticky dca-sticky--${vm.cls}`}>
        <div className="dca-sticky-main">
          <span className={`dca-ai-verb dca-ai-verb--${verb.toLowerCase()} dca-sticky-verb`} aria-hidden>{vm.glyph}</span>
          <div className="dca-sticky-meta">
            <span className="dca-sticky-tone t-title-sm">{verb !== "—" ? `${verb} · ${vm.tone}` : "Not analysed yet"}</span>
            <span className="t-body-sm-short">{lensLine}</span>
            <span className="t-caption">
              Confidence: {(verdict?.confidence ?? "—").toUpperCase()} · Risk: {manualReviewSteps.length} manual review{manualReviewSteps.length === 1 ? "" : "s"}
              {" · "}{counts.total} step{counts.total === 1 ? "" : "s"} · {counts.approved} approved · {counts.pending} pending
            </span>
          </div>
        </div>
        {verdict && (
          <div className="dca-sticky-actions">
            <button type="button" className="pl-btn pl-btn-primary pl-btn-s" onClick={approveAll} disabled={submitted}>
              Approve All
            </button>
            <button type="button" className="pl-btn pl-btn-outline pl-btn-s" onClick={scrollToVerdict}>
              Review Step by Step ↓
            </button>
          </div>
        )}
      </div>

      {children}

      {/* B4 — verdict + per-step approve/override */}
      <section ref={verdictRef} id="verdict" className="pl-card pl-card-elevated pl-card-padded dca-verdict">
        <h2 className="t-title-base">Verdict</h2>

        {!verdict ? (
          <p className="dca-strategic t-body-sm-short">No persisted analysis for this event yet — run the AI brain.</p>
        ) : (
          <>
            <div className={`dca-verdict-banner dca-verdict-banner--${vm.cls}`}>
              <span className="dca-verdict-glyph" aria-hidden>{vm.glyph}</span>
              <div>
                <div className="t-title-base">{verb} — {vm.tone}</div>
                <div className="dca-lens-window t-caption">{lensLine} · AI confidence {verdict.confidence}</div>
              </div>
            </div>

            {manualReviewSteps.length > 0 && (
              <div className="dca-manual-review">
                <span className="dca-manual-review-title t-body-sm-strong">⚠ Manual Review Required</span>
                <p className="t-caption" style={{ margin: 0 }}>
                  AI suggests escalating to a strategist before acting. {manualReviewSteps[0].text}
                </p>
              </div>
            )}

            <p className="dca-strategic t-body-sm-short">{verdict.strategic_context || "No strategic context returned."}</p>

            {/* per-step approve / override */}
            <div className="dca-steps">
              {steps.length === 0 ? (
                celebratory ? (
                  <div className="dca-step-continue"><span className="dca-step-continue-tick" aria-hidden>✓</span> Continue current allocation — no changes needed.</div>
                ) : (
                  <p className="t-caption">No tactical steps — current allocation is performing.</p>
                )
              ) : (
                steps.map((s) => {
                  const st = status[s.id] ?? "pending";
                  if (isContinueStep(s.text)) {
                    return (
                      <div key={s.id} className="dca-step-continue">
                        <span className="dca-step-continue-tick" aria-hidden>✓</span> {s.text}
                      </div>
                    );
                  }
                  return (
                    <div key={s.id} className={`dca-step dca-step--${st}`}>
                      <div className="dca-step-body t-body-sm-short">
                        <span className="dca-chip">{s.channel}</span> {s.text}
                      </div>
                      <div className="dca-step-actions">
                        <button
                          type="button"
                          className={`pl-btn pl-btn-s ${st === "approved" ? "pl-btn-primary" : "pl-btn-outline"}`}
                          onClick={() => setStep(s.id, "approved")}
                          disabled={submitted}
                        >
                          ✓ Approve
                        </button>
                        <button
                          type="button"
                          className={`pl-btn pl-btn-s ${st === "dismissed" ? "pl-btn-primary" : "pl-btn-outline"}`}
                          onClick={() => { setStep(s.id, "dismissed"); setOpenOverride(openOverride === s.id ? null : s.id); }}
                          disabled={submitted}
                        >
                          ✗ Override
                        </button>
                      </div>
                      {(openOverride === s.id || (st === "dismissed" && overrides[s.id])) && (
                        <div className="dca-override">
                          <label className="t-label-sm">Why are you overriding?</label>
                          <select
                            className="dca-select"
                            value={overrides[s.id]?.reason ?? ""}
                            onChange={(e) => setOverrides((p) => ({ ...p, [s.id]: { reason: e.target.value, notes: p[s.id]?.notes ?? "" } }))}
                            disabled={submitted}
                          >
                            <option value="">Select reason…</option>
                            {OVERRIDE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                          <input
                            className="dca-input"
                            placeholder="Notes (optional)"
                            value={overrides[s.id]?.notes ?? ""}
                            onChange={(e) => setOverrides((p) => ({ ...p, [s.id]: { reason: p[s.id]?.reason ?? "Other", notes: e.target.value } }))}
                            disabled={submitted}
                          />
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* verdict-level action override */}
            <div className="dca-final-action">
              <label className="t-label-sm">Final action (change if you disagree with the AI)</label>
              <select className="dca-select" value={finalAction} onChange={(e) => setFinalAction(e.target.value)} disabled={submitted}>
                {ACTIONS.map((a) => <option key={a} value={a}>{a}{a === verdict.recommended_action ? " (AI)" : ""}</option>)}
              </select>
            </div>

            {/* expected outcome (mandatory) */}
            <div className="dca-outcome">
              <label className="t-label-sm">Expected outcome (required before submit)</label>
              <select className="dca-select" value={outcomeSel} onChange={(e) => setOutcomeSel(e.target.value)} disabled={submitted}>
                <option value="">Select what you expect…</option>
                {outcomeOptions.map((o, i) => <option key={i} value={o}>{o}</option>)}
                <option value="__custom__">Other (write your own)…</option>
              </select>
              {outcomeSel === "__custom__" && (
                <input
                  className="dca-input"
                  placeholder="Describe the measurable outcome you expect…"
                  value={outcomeCustom}
                  onChange={(e) => setOutcomeCustom(e.target.value)}
                  disabled={submitted}
                />
              )}
            </div>

            {err && <p className="dca-ref-line t-caption" style={{ color: "var(--accent-alert)" }}>Submit failed: {err}</p>}

            <div className="dca-verdict-actions">
              {submitted ? (
                <span className="pl-status-tag pl-status-tag--success">✓ Decision logged</span>
              ) : (
                <button type="button" className="pl-btn pl-btn-primary pl-btn-m" onClick={submit} disabled={!canSubmit}>
                  {submitting ? "Submitting…" : "Submit Decision"}
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
