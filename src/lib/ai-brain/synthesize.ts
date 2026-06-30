/**
 * Verdict synthesis (P2.2) — Sonnet 4.5 (analog matching + synthesis is hard
 * for Haiku). Takes the 6 lens outputs + KPIs → one verdict with an action verb,
 * atomic tactical steps, and a strategic-context paragraph.
 */

import type { EventReport } from "@/src/lib/data/events";
import { chatJSON } from "@/src/lib/openrouter";
import { MASTER_SYSTEM } from "./master-prompt";
import { segmentsStr, ownSegmentsStr, inventoryStr } from "./lenses";
import type { LensOutput, Verdict } from "./types";

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (x: number) => (x >= 0 ? "+" : "") + r2(x * 100) + "%";

/** Has the show date already passed? (code-computed; the model has no clock). */
function showHasPassed(report: EventReport): boolean {
  if (!report.event.date) return false;
  const show = new Date(report.event.date.slice(0, 10) + "T00:00:00Z").getTime();
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
  return show < today;
}

/** Compact benchmark + state line so the AI can apply the verdict thresholds. */
function benchmarksStr(report: EventReport): string {
  const cb = report.clusterBaseline;
  const d = report.deltas;
  const meta = report.channels.find((c) => c.source === "Meta");
  const google = report.channels.find((c) => c.source.toLowerCase() === "google");
  const price = report.kpis.avg_ticket_price;
  // Code-computed timing — the model has no clock and otherwise mis-judges
  // whether the show has passed (drives PAUSE/KILL).
  const todayIso = new Date().toISOString().slice(0, 10);
  const showDate = report.event.date ? report.event.date.slice(0, 10) : null;
  let timing = "show date unknown";
  if (showDate) {
    const days = Math.round((new Date(showDate + "T00:00:00Z").getTime() - new Date(todayIso + "T00:00:00Z").getTime()) / 86_400_000);
    timing = days < 0 ? `show date ${showDate} — ALREADY PASSED ${-days} day(s) ago` : days === 0 ? `show date ${showDate} — TODAY` : `show date ${showDate} — in ${days} day(s)`;
  }
  const parts = [
    `today ${todayIso}`,
    timing,
    `event total ROAS ${r2(report.kpis.total_roas)}x`,
    cb?.matched && cb.roas_p50 != null ? `cluster ROAS p50 ${r2(cb.roas_p50)}x` : "cluster ROAS p50 n/a",
    cb?.matched && cb.cpa_p50 != null ? `cluster CPA p50 AED ${r2(cb.cpa_p50)}` : "cluster CPA p50 n/a",
    meta ? `Meta: CPA AED ${r2(meta.cpa)}, ROAS ${r2(meta.roas)}x, spend AED ${r2(meta.spend)}` : "no Meta spend",
    google ? `Google: CPA AED ${r2(google.cpa)}, ROAS ${r2(google.roas)}x, spend AED ${r2(google.spend)}` : "no Google spend",
    d ? `WoW: sales ${pct(d.total_sales.pct)}, tickets ${pct(d.tickets.pct)}, ROAS ${pct(d.total_roas.pct)}` : "WoW n/a",
    `event status: ${report.event.status || "unknown"}`,
    `avg ticket price AED ${r2(price)} (10% = AED ${r2(price * 0.1)})`,
    `INVENTORY: ${inventoryStr(report)}`,
  ];
  return parts.join(" | ");
}

/**
 * STEP 3 FIX M / STEP 4 FIX P — deterministic data-quality weakness. True when
 * >=2 EVENT-SPECIFIC signal sources are missing. GA4 funnel is deliberately
 * EXCLUDED: it is NULL platform-wide (a known upstream join gap), so it's a
 * constant — counting it flagged ~56% of events and diluted the signal. The
 * model is also asked to flag weakness; we OR in this check so a thin verdict
 * can never be silently auto-actioned.
 */
function dataSignalWeak(report: EventReport, lenses: LensOutput[]): { weak: boolean; factors: string[] } {
  const factors: string[] = [];
  const cb = report.clusterBaseline;
  if (!cb || !cb.matched || (cb.sample_size ?? 0) < 20) factors.push("no reliable cluster benchmark (under 20 similar events)");
  const analogs = report.analogs?.length ?? 0;
  const sibs = report.affinitySiblings?.length ?? 0;
  if (analogs === 0 && sibs === 0) factors.push("no analog or affinity reference events");
  // Count low-trust lenses EXCLUDING GA4 (its low trust is a constant gap).
  const lowTrustNonGa4 = lenses.filter((l) => l.lens !== "ga4" && l.confidence === "low").length;
  if (lowTrustNonGa4 >= 4) factors.push(`${lowTrustNonGa4} of 5 non-GA4 lenses are low-trust`);
  if (!report.deltas) factors.push("no week-over-week comparison available");
  // Weak only when MULTIPLE independent, event-specific sources are missing.
  return { weak: factors.length >= 2, factors };
}

const VERDICT_SCHEMA =
  `Return ONLY this JSON: {"primary_lens": <lens key or null>, "contributing_lenses": [<lens keys>], ` +
  `"recommended_action": "KILL"|"PAUSE"|"OPTIMIZE"|"SCALE"|"REMARKET"|"HOLD", ` +
  `"tactical_steps": [{"id": <int>, "text": <atomic action>, "channel": "meta"|"google"|"internal"|"cross"}], ` +
  `"strategic_context": <one paragraph>, "expected_outcome_template": <one editable sentence>, ` +
  `"expected_outcome_options": [<3-5 short, MEASURABLE predictions the approver could pick, each with a number+timeframe, e.g. "Meta CPA drops below AED 50 within 5 days">], ` +
  `"manual_review_required": <true|false — true ONLY when data signal is too weak to confidently recommend an action>, ` +
  `"confidence": "high"|"medium"|"low"}. Lens keys: internal, meta, google, ga4, last_week, market. ` +
  `Output 1-4 tactical_steps (HOLD: 0-1). Keep each step to <=2 sentences. ` +
  `CRITICAL — emit STRICTLY VALID JSON parseable by JSON.parse: escape every internal double-quote as \\", ` +
  `put NO literal newline inside any string value, and wrap ad/audience/event names in single quotes (') not double quotes.`;

export async function synthesize(
  report: EventReport,
  eventName: string,
  lenses: LensOutput[],
): Promise<Verdict> {
  const lensSummary = lenses
    .map((l) => `- ${l.lens}: ${l.lens_score == null ? "NO DATA" : `score ${l.lens_score}`} (${l.severity}, trust ${l.confidence}) — ${l.diagnosis_bullets.join("; ") || "no findings"}`)
    .join("\n");

  const kpis = `sales AED ${r2(report.kpis.total_sales_aed)}, spend AED ${r2(report.kpis.total_spend_aed)}, ROAS ${r2(report.kpis.total_roas)}x, tickets ${report.kpis.tickets_sold}, avg price AED ${r2(report.kpis.avg_ticket_price)}`;

  const segments = segmentsStr(report);
  const ownMeta = ownSegmentsStr(report, "meta");
  const ownGoogle = ownSegmentsStr(report, "google");
  const benchmarks = benchmarksStr(report);

  const user =
    `Synthesise the 6-lens findings into ONE verdict for "${eventName}".\n\n` +
    `KPIs: ${kpis}\n\nBENCHMARKS & STATE: ${benchmarks}\n\nLENS FINDINGS:\n${lensSummary}\n\n` +
    `THIS EVENT'S OWN META AD SETS:\n${ownMeta}\n\nTHIS EVENT'S OWN GOOGLE AD GROUPS:\n${ownGoogle}\n\n` +
    `RUNNING AFFINITY SIBLINGS' WINNING SEGMENTS (borrow-the-winner candidates):\n${segments}\n\n` +
    // ── action selection ─────────────────────────────────────────────
    `ABSOLUTE: if the BENCHMARKS line says the show date "ALREADY PASSED", the event is over — recommended_action MUST be PAUSE (or KILL if status is ended). NEVER HOLD/OPTIMIZE/SCALE/REMARKET a concluded show, no matter how strong its final ROAS was.\n` +
    `CHOOSE recommended_action with these rules (for events still upcoming; HOLD is the DEFAULT for healthy ones — OPTIMIZE is NOT a catch-all):\n` +
    `• HOLD — event ROAS >= cluster ROAS p50 AND no WoW decline >15% on sales/tickets/ROAS AND no red lens AND no within-event efficiency gap >=3x. tactical_steps = [] or a single "Continue current allocation — no action needed". strategic_context: 1 sentence on why it's working.\n` +
    `• SCALE — event ROAS >= 1.5x cluster ROAS p50 AND WoW up on ROAS or conversions AND not saturated (if Meta frequency known, < 3x; if frequency unknown, don't block on it). Give specific budget-increase steps.\n` +
    `• OPTIMIZE — MIXED signal only (some lenses green, some yellow/red) AND fixable by within-event moves (pause a weak ad set, scale a winner, refresh creative). Do NOT use as a catch-all for healthy campaigns.\n` +
    `• PAUSE — show date already passed, OR event ROAS < 50% of cluster p50 for 5+ days, OR Meta CPA > 3x ticket price sustained. Give the reason + restart criteria.\n` +
    `• KILL — event status is "ended", OR zero conversions on 7+ days of real spend (>1000 AED). Give cleanup steps.\n` +
    `• REMARKET — traffic exists (GA4 / Meta conversions / Google clicks) BUT conversion rate < 1% (browsing, not buying). Give retarget-pool details.\n` +
    `strategic_context MUST OPEN with the triggering rule, e.g. "HOLD triggered: ROAS 19x ≥ cluster 14x, no WoW decline >15%, no red lens."\n` +
    // ── inventory / urgency weighting (FIX I) ───────────────────────
    `INVENTORY URGENCY (use the INVENTORY field on the BENCHMARKS line; if capacity is UNKNOWN or UNRELIABLE, IGNORE these rules and use the standard ROAS logic above — never invent a sell-through):\n` +
    `• strong ROAS + sold ≥ 90% of capacity → HOLD (near sold-out; do NOT scale into a near-full house — extra spend is wasted).\n` +
    `• strong ROAS + sold < 30% + ≤ 7 days to event → SCALE URGENTLY (or REMARKET if traffic exists but isn't converting) — name the daily/lifetime budget lift and the pace gap.\n` +
    `• weak ROAS + sold < 30% + ≤ 7 days to event → REMARKET URGENT — the show is close and under-sold; lean on warm/retargeting pools.\n` +
    `• strong ROAS + sold < 30% + > 30 days to event → SCALE NORMALLY (early pre-sale; build awareness, no panic).\n` +
    `• 'behind' pace generally argues for SCALE/REMARKET; 'ahead' pace argues for HOLD. Always cite the pace numbers ("selling 18/day, needs 32/day") in strategic_context when capacity is reliable.\n` +
    `Lens scores are anchored to the CLUSTER MEDIAN. Do NOT escalate to PAUSE/KILL because a lens looks weak vs an analog outlier — only act on metrics that are genuinely worse than the cluster median. A lens marked NO DATA (e.g. GA4 with no funnel rows) is MISSING information — never treat it as a green/healthy contributing factor.\n\n` +
    // ── tactical step format ─────────────────────────────────────────
    `primary_lens = the single highest-signal red lens (or null if all green). contributing_lenses = lenses scoring >30 that aren't primary.\n` +
    `EVERY tactical_step MUST contain ALL FIVE of: (1) the EXACT name from the data (ad-set/audience/campaign/ad-group string from the OWN-ad-sets or sibling-segment lists — never "narrow audience" or "the broad ad set" without naming which); (2) a SPECIFIC budget in AED + duration in days; (3) a SPECIFIC success metric to check at the end; (4) WHO executes — "Khaled (manual)" or an auto-pause threshold or "Manual Review Required"; (5) the REASON beyond the metric gap (WHY this action, not just "underperforms").\n` +
    `If you CANNOT produce all five for a step (e.g. no real ad-set name is available), OMIT that step entirely — do NOT pad with a vague entry. Fewer, fully-specified steps beat more vague ones. It is valid to return zero steps.\n` +
    `GOOD example: "Pause Meta ad set 'concerts-X-Arabic' for 3 days. Reason: spend AED 375 with 0 tracked conversions — budget burning on a non-converting audience while 'LALs-X-Arabic' converts at AED 28 CPA. Action: Khaled (manual). Success metric: if blended Meta CPA drops below AED 30 within 3 days, retire it; reallocate its budget to 'LALs-X-Arabic' inside the same campaign."\n` +
    `BAD example (DO NOT EMIT): "Kill ad set 'concerts-X-Arabic' (ROAS 1.9x) — underperforms top by 37x." (no WHY-kill, no test path, no success metric, no actor.)\n\n` +
    // ── constraints ──────────────────────────────────────────────────
    `META BUDGET CONSTRAINT: Meta runs on a LIFETIME budget at CAMPAIGN level. Do NOT recommend "daily budget" changes for Meta — instead recommend "adjust the event campaign's lifetime budget" or "manually reallocate budget to the winning ad set INSIDE the existing campaign". Google ad-group budget changes are fine to recommend normally.\n` +
    `Budget moves are WITHIN this event only (Meta↔Google, ad set↔ad set) — NEVER across events; if within-event moves can't fix it, escalate to a human.\n` +
    `Own ad sets are tagged [audience: …]. If a real audience PATTERN is visible (lookalikes beating broad, retargeting beating interest), name it with the gap. If tags are creative_only/unclear, do not claim a pattern.\n` +
    `AFFINITY RECOMMENDATIONS must be SPECIFIC — the generic phrase "test similar audiences" (or any unnamed variant) is BANNED.\n` +
    `• If a RUNNING sibling has a winning named segment AND this event underperforms on that channel, you MAY add ONE step naming the sibling event + its winning ad-set/audience, e.g. "Test 'This is Michael's winning Meta ad set 'video-reel-LAL' on this campaign — allocate AED 200/day for 5 days on a new ad set, success: CPA below AED 25 within 5 days, action: Khaled (manual)".\n` +
    `• If PAST co-purchase neighbours are listed (marked [PAST co-purchase edition]), PREFER them — cite the exact neighbour event NAME + id + shared-buyer COUNT and frame it as a lookalike SEED, e.g. "Build a Meta lookalike seeded from the 316 buyers of 'Angham at Coca-Cola Arena 2024' (97499) — confirmed co-purchase overlap. Allocate AED 200/day for 5 days on a new ad set 'LAL-from-97499-buyers'. Success: CPA below AED 25 within 5 days. Action: Khaled (manual)".\n` +
    `• If there is NO affinity data at all (no running siblings AND no co-purchase neighbours), do NOT fabricate one — omit any affinity step entirely (state "No affinity data available for this event" only if directly relevant). Never cite a count or event name that is not in the data above.\n` +
    `CRITICAL (Sacred Rule #11): if there is NO real within-event efficiency gap or opportunity, do NOT invent one. Output a single tactical step "No within-event optimization needed — current allocation is performing." Cite ACTUAL names + ACTUAL numbers only.\n\n` +
    `strategic_context = one paragraph (opening with the triggering rule) weaving channel / pricing / commercial angles, grounded in cited numbers. ` +
    // ── HOLD brevity (FIX K) ─────────────────────────────────────────
    `IF recommended_action = HOLD: strategic_context is a HARD CAP of 2 sentences — write exactly 1-2 short factual sentences and STOP, even if nuance is lost (no third sentence, no motivational filler, no listing every ad set). Example (this length, not longer): "Sales pacing +7% week-over-week with ROAS above the cluster average. No within-event efficiency gap or red lens." tactical_steps = [] OR a single step "No action needed — continue monitoring". expected_outcome_options must focus on MONITORING (e.g. "ROAS stays above the cluster average over the next 7 days", "No drop in CTR or CPA", "Sell-through stays on pace"). ` +
    // ── manual review (FIX M) ────────────────────────────────────────
    `SET manual_review_required = true ONLY when the data signal is genuinely too weak to confidently automate — i.e. TWO OR MORE of: no cluster benchmark (or under 20 similar events), no analog AND no affinity reference events, most lenses low-trust, or no week-over-week comparison. Do NOT base this on GA4 funnel being missing — that is a known platform-wide data gap, not an event-specific weakness. When true: keep recommended_action to a conservative baseline (OPTIMIZE, or HOLD if nothing is clearly wrong), list the specific weakness factors in strategic_context, and do NOT emit aggressive KILL/SCALE steps. When manual_review_required is FALSE, do NOT use "strategist review required" / "data signal weak" language anywhere in strategic_context. ` +
    `For HOLD and SCALE (when NOT manual-review), OPEN with an affirming sentence about what's working ("This campaign is performing — …") before any nuance; a healthy verdict should feel earned, not boring. ` +
    `Write PLAIN ENGLISH for a marketer — NEVER use "p50", "percentile", or "n=" notation anywhere; say "the average across 111 similar events" or "10x above similar events" instead. ` +
    `expected_outcome_template = one editable sentence the approver completes. ` +
    `expected_outcome_options = 3-5 outcomes SPECIFIC to THIS verdict — each MUST cite a REAL asset (the actual ad-set / audience / campaign name from the data) and concrete numbers, e.g. "CPA on 'Arabic-expats-interests' ad set drops below AED 12 within 5 days" or "Remarketing audience converts 30%+ within 7 days" — NEVER generic ("Meta CPA improves", "better targeting yields results"). Map them to the tactical steps' success metrics, and include ONE "monitor only — no action needed" style option. If you cannot produce 3+ asset-specific options, output the 1-2 you CAN and add a final "Other (specify)" option. Plain English, no jargon.\n\n` +
    VERDICT_SCHEMA;

  const { data } = await chatJSON<Verdict>({
    model: "sonnet",
    system: MASTER_SYSTEM,
    user,
    maxTokens: 2500,
  });

  // Deterministic guardrail: a concluded event (show date passed) can never be
  // HOLD/OPTIMIZE/SCALE/REMARKET — you cannot optimise a finished show. Force
  // PAUSE (stop post-event spend) regardless of what the model returned.
  let action = data.recommended_action ?? "HOLD";
  if (showHasPassed(report) && ["HOLD", "OPTIMIZE", "SCALE", "REMARKET"].includes(action)) {
    action = "PAUSE";
  }

  // FIX M / FIX P: OR the model's manual_review flag with a deterministic
  // data-quality check so a thin-data verdict can never be silently auto-actioned.
  // BUT a deterministic show-passed PAUSE/KILL is already decisive — it needs no
  // strategist review, so suppress the flag (and the weak-data tail) there.
  const weak = dataSignalWeak(report, lenses);
  const decisivePassed = showHasPassed(report) && (action === "PAUSE" || action === "KILL");
  const manual_review_required = decisivePassed
    ? false
    : data.manual_review_required === true || weak.weak;
  let strategic_context = String(data.strategic_context ?? "");
  if (manual_review_required && weak.weak && data.manual_review_required !== true) {
    strategic_context +=
      (strategic_context ? " " : "") +
      `Data signal weak — recommend strategist review before automating. Factors: ${weak.factors.join("; ")}.`;
  }

  // Light coercion so the UI never breaks on a malformed field.
  return {
    primary_lens: data.primary_lens ?? null,
    contributing_lenses: Array.isArray(data.contributing_lenses) ? data.contributing_lenses : [],
    recommended_action: action,
    tactical_steps: Array.isArray(data.tactical_steps)
      ? data.tactical_steps.slice(0, 5).map((s, i) => ({ id: s.id ?? i + 1, text: String(s.text ?? ""), channel: String(s.channel ?? "cross") }))
      : [],
    strategic_context,
    expected_outcome_template: String(data.expected_outcome_template ?? ""),
    expected_outcome_options: Array.isArray(data.expected_outcome_options)
      ? data.expected_outcome_options.slice(0, 5).map((s) => String(s))
      : undefined,
    confidence: data.confidence ?? "low",
    manual_review_required,
  };
}
