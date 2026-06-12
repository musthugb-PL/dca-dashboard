/**
 * Verdict synthesis (P2.2) — Sonnet 4.5 (analog matching + synthesis is hard
 * for Haiku). Takes the 6 lens outputs + KPIs → one verdict with an action verb,
 * atomic tactical steps, and a strategic-context paragraph.
 */

import type { EventReport } from "@/src/lib/data/events";
import { chatJSON } from "@/src/lib/openrouter";
import { MASTER_SYSTEM } from "./master-prompt";
import { segmentsStr, ownSegmentsStr } from "./lenses";
import type { LensOutput, Verdict } from "./types";

const r2 = (n: number) => Math.round(n * 100) / 100;

const VERDICT_SCHEMA =
  `Return ONLY this JSON: {"primary_lens": <lens key or null>, "contributing_lenses": [<lens keys>], ` +
  `"recommended_action": "KILL"|"PAUSE"|"OPTIMIZE"|"SCALE"|"REMARKET"|"HOLD", ` +
  `"tactical_steps": [{"id": <int>, "text": <atomic action>, "channel": "meta"|"google"|"internal"|"cross"}], ` +
  `"strategic_context": <one paragraph>, "expected_outcome_template": <one editable sentence>, ` +
  `"confidence": "high"|"medium"|"low"}. Lens keys: internal, meta, google, ga4, last_week, market.`;

export async function synthesize(
  report: EventReport,
  eventName: string,
  lenses: LensOutput[],
): Promise<Verdict> {
  const lensSummary = lenses
    .map((l) => `- ${l.lens}: score ${l.lens_score} (${l.severity}, conf ${l.confidence}) — ${l.diagnosis_bullets.join("; ") || "no findings"}`)
    .join("\n");

  const kpis = `sales AED ${r2(report.kpis.total_sales_aed)}, spend AED ${r2(report.kpis.total_spend_aed)}, ROAS ${r2(report.kpis.total_roas)}x, tickets ${report.kpis.tickets_sold}, avg price AED ${r2(report.kpis.avg_ticket_price)}`;

  const segments = segmentsStr(report);
  const ownMeta = ownSegmentsStr(report, "meta");
  const ownGoogle = ownSegmentsStr(report, "google");

  const user =
    `Synthesise the 6-lens findings into ONE verdict for "${eventName}".\n\n` +
    `KPIs: ${kpis}\n\nLENS FINDINGS:\n${lensSummary}\n\n` +
    `THIS EVENT'S OWN META AD SETS:\n${ownMeta}\n\nTHIS EVENT'S OWN GOOGLE AD GROUPS:\n${ownGoogle}\n\n` +
    `RUNNING AFFINITY SIBLINGS' WINNING SEGMENTS (borrow-the-winner candidates):\n${segments}\n\n` +
    `Rules: primary_lens = the single highest-signal red lens (or null if all green). ` +
    `contributing_lenses = lenses scoring >30 that aren't primary. ` +
    `tactical_steps = 3-5 atomic, individually-actionable steps, each tied to a channel. ` +
    `Budget moves are WITHIN this event only (Meta↔Google, ad set↔ad set) — NEVER suggest moving budget to other events; ` +
    `if within-event optimisation can't fix it, the action is escalation to a human. ` +
    `IF this event's own ad-set distribution shows a clear efficiency gap (a top performer's ROAS/efficiency >=3x the worst), ADD atomic steps citing the EXACT ad_name/campaign strings, e.g. ` +
    `"Kill Meta ad set \\"<name>\\" (CPA AED X, ROAS Yx)" and "Scale Meta ad set \\"<name>\\" (CPA AED X, ROAS Yx) +50% budget". ` +
    `IF a winning sibling segment is listed AND this event underperforms on that channel, ADD one tactical step of the form: ` +
    `"Test [Sibling Name]'s winning [audience/creative]: <named ad/audience>, converting <N×/ROAS> better than our current pool — allocate AED <X> for <Y> days." ` +
    `Cite ACTUAL names + ACTUAL numbers; if no own-segment gap and no sibling segment clearly wins, do NOT invent one (Sacred Rules #9 + #11). ` +
    `strategic_context = one paragraph weaving brand / channel / pricing / commercial angles, grounded in the cited numbers. ` +
    `expected_outcome_template = one editable sentence the approver will complete (e.g. "Expect Meta CPA to fall from X to Y within 3 days").\n\n` +
    VERDICT_SCHEMA;

  const { data } = await chatJSON<Verdict>({
    model: "sonnet",
    system: MASTER_SYSTEM,
    user,
    maxTokens: 1100,
  });

  // Light coercion so the UI never breaks on a malformed field.
  return {
    primary_lens: data.primary_lens ?? null,
    contributing_lenses: Array.isArray(data.contributing_lenses) ? data.contributing_lenses : [],
    recommended_action: data.recommended_action ?? "HOLD",
    tactical_steps: Array.isArray(data.tactical_steps)
      ? data.tactical_steps.slice(0, 5).map((s, i) => ({ id: s.id ?? i + 1, text: String(s.text ?? ""), channel: String(s.channel ?? "cross") }))
      : [],
    strategic_context: String(data.strategic_context ?? ""),
    expected_outcome_template: String(data.expected_outcome_template ?? ""),
    confidence: data.confidence ?? "low",
  };
}
