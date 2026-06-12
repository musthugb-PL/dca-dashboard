/**
 * AI-brain persistence (P2.2 step 5).
 *
 * Writes a BrainAnalysis to dca_ai_analyses and reads it back.
 *
 * Idempotent on (event_id, slot, date): the table has no explicit `date`
 * column, so "date" = the UTC day of `generated_at`. Same-day re-runs for the
 * same (event_id, slot) delete the prior row, then insert the fresh one — the
 * exact pattern used by the Red Flag detector (red-flag-run.ts). These are
 * auto-generated analysis rows regenerated each run, not user-authored data.
 *
 * Server-only: imports the service-role Supabase client. Never from a Client
 * Component.
 */

import { getSupabase } from "@/lib/supabase";
import type { Slot } from "@/src/lib/slot";
import type { BrainAnalysis, LensOutput, Verdict } from "./types";

const TABLE = "dca_ai_analyses";

type AnalysisRow = {
  event_id: string;
  slot: number | null;
  generated_at: string;
  primary_lens: string | null;
  recommended_action: string | null;
  confidence: string | null;
  lenses: LensOutput[];
  verdict: Verdict;
};

const SELECT_COLS =
  "event_id, slot, generated_at, primary_lens, recommended_action, confidence, lenses, verdict";

/** UTC [start, end) bounds for the day of `d`. */
function utcDayBounds(d: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function rowToAnalysis(r: AnalysisRow): BrainAnalysis {
  return {
    event_id: Number(r.event_id),
    generated_at: r.generated_at,
    lenses: Array.isArray(r.lenses) ? r.lenses : [],
    verdict: r.verdict,
  };
}

/**
 * Persist one analysis. Idempotent on (event_id, slot, UTC day of generated_at):
 * clears any same-day row for this (event_id, slot) first, then inserts.
 */
export async function saveBrainAnalysis(analysis: BrainAnalysis, slot: Slot): Promise<void> {
  const sb = getSupabase();
  const eventId = String(analysis.event_id);
  const { start, end } = utcDayBounds(new Date(analysis.generated_at));

  const del = await sb
    .from(TABLE)
    .delete()
    .eq("event_id", eventId)
    .eq("slot", slot)
    .gte("generated_at", start)
    .lt("generated_at", end);
  if (del.error) throw new Error("clear prior analysis: " + del.error.message);

  const ins = await sb.from(TABLE).insert({
    event_id: eventId,
    slot,
    generated_at: analysis.generated_at,
    primary_lens: analysis.verdict.primary_lens,
    recommended_action: analysis.verdict.recommended_action,
    confidence: analysis.verdict.confidence,
    lenses: analysis.lenses,
    verdict: analysis.verdict,
  });
  if (ins.error) throw new Error("insert analysis: " + ins.error.message);
}

/**
 * Latest persisted analysis for an event, regardless of slot/date. Used by the
 * report page (which is keyed only on event_id).
 */
export async function getLatestBrainAnalysis(
  eventId: string | number,
): Promise<BrainAnalysis | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from(TABLE)
    .select(SELECT_COLS)
    .eq("event_id", String(eventId))
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return rowToAnalysis(data as AnalysisRow);
}

/**
 * Today's analyses for a slot, keyed by event_id. Used by the dashboard cards.
 * Returns only rows generated on `runDate`'s UTC day (the current review run).
 */
export async function getBrainAnalysesForSlot(
  slot: Slot,
  eventIds: string[],
  runDate: Date = new Date(),
): Promise<Map<string, BrainAnalysis>> {
  const map = new Map<string, BrainAnalysis>();
  if (eventIds.length === 0) return map;
  const sb = getSupabase();
  const { start, end } = utcDayBounds(runDate);
  const { data, error } = await sb
    .from(TABLE)
    .select(SELECT_COLS)
    .eq("slot", slot)
    .in("event_id", eventIds)
    .gte("generated_at", start)
    .lt("generated_at", end)
    .order("generated_at", { ascending: false });
  if (error || !data) return map;
  for (const r of data as AnalysisRow[]) {
    const k = String(r.event_id);
    if (!map.has(k)) map.set(k, rowToAnalysis(r)); // first seen = most recent
  }
  return map;
}
