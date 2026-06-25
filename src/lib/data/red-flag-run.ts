/**
 * Red Flag detection run (P2.1).
 *
 * Reuses getReviewCards (same data the dashboard shows) for today's slot, runs
 * the pure rule engine on each campaign's report, and writes hits to
 * dca_red_flag_events.
 *
 * Idempotent same-day re-runs: delete this slot's hits for the current UTC date,
 * then insert the fresh set. (These are auto-generated detector rows, regenerated
 * each run — not user-authored data.)
 *
 * NOTE: this is node-only (getEventReport uses the BigQuery node client), so it
 * runs as a Next.js API route (app/api/red-flag-detector) — NOT a Deno Edge
 * Function. The cron hits the deployed route.
 */

import { getSupabase } from "@/lib/supabase";
import { getReviewCards } from "./dashboard";
import { detectRedFlags } from "@/src/lib/red-flags";
import { slotForDate, mostRecentSlot, type Slot } from "@/src/lib/slot";

export type RedFlagRunResult = {
  slot: Slot;
  dateFrom: string;
  dateTo: string;
  scanned: number; // campaigns with a usable report
  hits: number;
  byRule: Record<string, number>;
  sample: { event_id: string; rule_key: string; severity: string; message: string }[];
};

export async function runRedFlagDetection(today: Date = new Date()): Promise<RedFlagRunResult> {
  const slot: Slot = slotForDate(today) ?? mostRecentSlot(today);
  // includePrior → reports carry WoW deltas so roas_wow + ctr_drop can fire.
  const { cards, dateFrom, dateTo } = await getReviewCards(slot, today, { includePrior: true });

  const nowIso = new Date().toISOString();
  const hits: Record<string, unknown>[] = [];
  const byRule: Record<string, number> = {};
  let scanned = 0;

  for (const c of cards) {
    if (c.tooNew) continue; // new campaigns (<7d) never fire red flags (CLAUDE.md)
    if (!c.report) continue;
    scanned++;
    for (const f of detectRedFlags(c.report)) {
      byRule[f.rule_key] = (byRule[f.rule_key] ?? 0) + 1;
      hits.push({
        event_id: c.primaryEventId,
        detected_at: nowIso,
        slot,
        rule_key: f.rule_key,
        rule_value: f.value,
        threshold: f.threshold,
        severity: f.severity,
        message: f.message,
      });
    }
  }

  // Idempotency: clear this slot's hits for the current UTC date, then insert.
  const dayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const sb = getSupabase();
  const del = await sb
    .from("dca_red_flag_events")
    .delete()
    .eq("slot", slot)
    .gte("detected_at", dayStart.toISOString())
    .lt("detected_at", dayEnd.toISOString());
  if (del.error) throw new Error("clear today's hits: " + del.error.message);

  if (hits.length) {
    const ins = await sb.from("dca_red_flag_events").insert(hits);
    if (ins.error) throw new Error("insert hits: " + ins.error.message);
  }

  return {
    slot,
    dateFrom,
    dateTo,
    scanned,
    hits: hits.length,
    byRule,
    sample: hits.slice(0, 10).map((h) => ({
      event_id: String(h.event_id),
      rule_key: String(h.rule_key),
      severity: String(h.severity),
      message: String(h.message),
    })),
  };
}
