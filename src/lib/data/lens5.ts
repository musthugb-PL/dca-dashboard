/**
 * Lens 5 (Last Week) context assembly.
 *
 * EXACT event_id match ONLY across all four sources — no fuzzy name matching.
 * Fuzzy token matching was removed (it produced false matches, e.g. "Live
 * Nation" → "Zayed National Museum"). Better silent than wrong.
 *
 *   1. dca_decisions             — event_id = current
 *   2. dca_source_b_weekly_notes — event_id = current
 *   3. dca_source_b_notes        — event_id = current
 *   4. dca_v_optimisation_notes  — event_id = current
 *
 * TRADE-OFF: dca_source_b_weekly_notes has ~66% NULL event_id rows; exact-only
 * loses those notes for affected events. Accepted — better to show nothing than
 * the wrong event's history.
 *
 * TODO: improve event_id resolution at SYNC time (populate
 * dca_source_b_weekly_notes.event_id from event_name during the weekly-notes
 * sync) so exact matching recovers those ~66% of rows.
 *
 * Empty result → the Lens 5 prompt states that honestly (Sacred Rule #11).
 */

import { getSupabase } from "@/lib/supabase";
import type { PastDecisions, PastDecisionItem } from "./events";

type SB = ReturnType<typeof getSupabase>;
const trim = (s: unknown, n = 300): string =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** All exact-event_id past decisions/notes for one event across the 4 sources. */
async function fetchExactDecisions(sb: SB, eid: string, perSourceLimit: number): Promise<PastDecisionItem[]> {
  const items: PastDecisionItem[] = [];

  try {
    const { data } = await sb
      .from("dca_decisions")
      .select("review_date,final_action,reasoning,expected_outcome,actual_outcome")
      .eq("event_id", eid)
      .order("review_date", { ascending: false })
      .limit(perSourceLimit);
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const parts = [trim(r.reasoning)];
      if (r.expected_outcome) parts.push("predicted: " + trim(r.expected_outcome, 160));
      if (r.actual_outcome) parts.push("actual: " + trim(r.actual_outcome, 160));
      items.push({
        source: "decisions", matched_by: "event_id",
        when: r.review_date ? String(r.review_date) : null, event_name: null,
        action: r.final_action ? String(r.final_action) : null,
        text: parts.filter(Boolean).join(" | "),
      });
    }
  } catch { /* best-effort */ }

  try {
    const { data } = await sb
      .from("dca_source_b_weekly_notes")
      .select("week_label,event_name,event_id,social_notes,google_notes,creative_notes,other_notes")
      .eq("event_id", eid)
      .limit(perSourceLimit);
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const notes = [
        r.social_notes && "social: " + trim(r.social_notes),
        r.google_notes && "google: " + trim(r.google_notes),
        r.creative_notes && "creative: " + trim(r.creative_notes),
        r.other_notes && "other: " + trim(r.other_notes),
      ].filter(Boolean) as string[];
      if (!notes.length) continue;
      items.push({
        source: "weekly_notes", matched_by: "event_id",
        when: r.week_label ? String(r.week_label) : null,
        event_name: r.event_name ? String(r.event_name) : null,
        action: null, text: notes.join(" | "),
      });
    }
  } catch { /* best-effort */ }

  try {
    const { data } = await sb
      .from("dca_source_b_notes")
      .select("week_of,event_id,event_name,action_taken,reasoning,prediction,actual_outcome")
      .eq("event_id", eid)
      .limit(perSourceLimit);
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const parts = [trim(r.reasoning)];
      if (r.prediction) parts.push("predicted: " + trim(r.prediction, 160));
      if (r.actual_outcome) parts.push("actual: " + trim(r.actual_outcome, 160));
      items.push({
        source: "source_b_notes", matched_by: "event_id",
        when: r.week_of ? String(r.week_of) : null,
        event_name: r.event_name ? String(r.event_name) : null,
        action: r.action_taken ? String(r.action_taken) : null,
        text: parts.filter(Boolean).join(" | "),
      });
    }
  } catch { /* best-effort */ }

  try {
    const { data } = await sb
      .from("dca_v_optimisation_notes")
      .select("week_of,author,content")
      .eq("event_id", eid)
      .order("week_of", { ascending: false })
      .limit(perSourceLimit);
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      if (!r.content) continue;
      items.push({
        source: "optimisation_notes", matched_by: "event_id",
        when: r.week_of ? String(r.week_of) : null, event_name: null,
        action: null, text: trim(r.content),
      });
    }
  } catch { /* best-effort */ }

  return items;
}

/**
 * Lens 5 / Fix 12: exact-event_id decisions for this event; if it has NONE,
 * fall back to the top-3 similar events' decisions (cross-event learning),
 * tagged with from_analog so the UI shows "From {analog} — similar event".
 */
export async function getPastDecisionsContext(
  eventId: number,
  _eventName: string, // kept for signature stability (exact id matching only)
  perSourceLimit = 15,
): Promise<PastDecisions> {
  const sb = getSupabase();
  const own = await fetchExactDecisions(sb, String(eventId), perSourceLimit);
  if (own.length > 0) return { items: own, count: own.length };

  // Fallback: borrow similar events' decisions.
  try {
    const { data } = await sb
      .from("dca_v_similar_events")
      .select("similar_event_id,rank")
      .eq("event_id", String(eventId))
      .order("rank")
      .limit(3);
    const sims = (data ?? []) as { similar_event_id: string; rank: number }[];
    if (!sims.length) return { items: [], count: 0 };

    const ids = sims.map((s) => String(s.similar_event_id));
    const { data: ev } = await sb.from("dca_v_events").select("event_id,event_name_en").in("event_id", ids);
    const nameMap = new Map(((ev ?? []) as { event_id: string; event_name_en: string }[]).map((e) => [String(e.event_id), e.event_name_en]));

    const pooled: PastDecisionItem[] = [];
    for (const s of sims) {
      const eid2 = String(s.similar_event_id);
      const its = await fetchExactDecisions(sb, eid2, perSourceLimit);
      const name = nameMap.get(eid2) ?? `event ${eid2}`;
      for (const it of its) pooled.push({ ...it, from_analog: name });
    }
    return { items: pooled.slice(0, 12), count: Math.min(pooled.length, 12), viaAnalogs: pooled.length > 0 };
  } catch {
    return { items: [], count: 0 };
  }
}
