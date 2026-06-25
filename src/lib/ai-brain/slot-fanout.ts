/**
 * Run the AI brain for every eligible campaign in a review slot and persist each
 * (same-day upsert). Shared by the /api/run-brain-fanout cron route and the
 * scripts/brain-slot-run.ts CLI. Eligible = status 'running' AND >=7 days old.
 */
import { getSupabase } from "@/lib/supabase";
import { runBrain } from "./run-brain";
import { saveBrainAnalysis } from "./persist";
import { reviewWindow, daysSince, type Slot } from "@/src/lib/slot";

const ACTIVE_MIN_DAYS = 7;

export type FanoutResult = {
  slot: Slot;
  dateFrom: string;
  dateTo: string;
  eligible: number;
  processed: number;
  failed: number;
  failures: { id: string; err: string }[];
};

export async function runSlotFanout(slot: Slot, today: Date = new Date()): Promise<FanoutResult> {
  const { dateFrom, dateTo } = reviewWindow(today);
  const sb = getSupabase();
  const { data, error } = await sb
    .from("dca_campaign_ledger")
    .select("event_id,event_ids,status,campaign_start_date")
    .eq("review_slot", String(slot));
  if (error) throw new Error("ledger: " + error.message);

  type Row = { event_id: string; event_ids: string[] | null; status: string | null; campaign_start_date: string | null };
  const rows = (data ?? []) as Row[];
  const eligible = rows.filter(
    (r) => (r.status ?? "").toLowerCase() === "running" && (daysSince(r.campaign_start_date, today) ?? -1) >= ACTIVE_MIN_DAYS,
  );
  const seen = new Set<string>();
  const targets = eligible
    .map((r) => r.event_ids?.[0] ?? r.event_id)
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)));

  let processed = 0;
  const failures: { id: string; err: string }[] = [];
  for (const id of targets) {
    try {
      const a = await runBrain(Number(id), dateFrom, dateTo);
      await saveBrainAnalysis(a, slot);
      processed++;
    } catch (e) {
      failures.push({ id, err: e instanceof Error ? e.message : String(e) });
    }
  }

  return { slot, dateFrom, dateTo, eligible: targets.length, processed, failed: failures.length, failures };
}
