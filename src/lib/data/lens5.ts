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

const trim = (s: unknown, n = 300): string =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export async function getPastDecisionsContext(
  eventId: number,
  _eventName: string, // kept for signature stability; no longer used (exact id only)
  perSourceLimit = 15,
): Promise<PastDecisions> {
  const sb = getSupabase();
  const eid = String(eventId);
  const items: PastDecisionItem[] = [];

  // 1. dca_decisions — exact event_id (this dashboard's own approve/override log).
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
        source: "decisions",
        matched_by: "event_id",
        when: r.review_date ? String(r.review_date) : null,
        event_name: null,
        action: r.final_action ? String(r.final_action) : null,
        text: parts.filter(Boolean).join(" | "),
      });
    }
  } catch {
    /* best-effort per source */
  }

  // 2. dca_source_b_weekly_notes — exact event_id (NO name fallback).
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
        source: "weekly_notes",
        matched_by: "event_id",
        when: r.week_label ? String(r.week_label) : null,
        event_name: r.event_name ? String(r.event_name) : null,
        action: null,
        text: notes.join(" | "),
      });
    }
  } catch {
    /* best-effort */
  }

  // 3. dca_source_b_notes (master) — exact event_id.
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
        source: "source_b_notes",
        matched_by: "event_id",
        when: r.week_of ? String(r.week_of) : null,
        event_name: r.event_name ? String(r.event_name) : null,
        action: r.action_taken ? String(r.action_taken) : null,
        text: parts.filter(Boolean).join(" | "),
      });
    }
  } catch {
    /* best-effort */
  }

  // 4. dca_v_optimisation_notes — exact event_id (existing dashboard's notes).
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
        source: "optimisation_notes",
        matched_by: "event_id",
        when: r.week_of ? String(r.week_of) : null,
        event_name: null,
        action: null,
        text: trim(r.content),
      });
    }
  } catch {
    /* best-effort */
  }

  return { items, count: items.length };
}
