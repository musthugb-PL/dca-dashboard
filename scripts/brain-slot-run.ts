/**
 * P2.2 full-slot fan-out: run the AI brain for EVERY eligible campaign in a
 * review slot (status=running AND >=7 days since launch), persist each to
 * dca_ai_analyses (idempotent same-day upsert).
 *
 * Usage:  npx tsx scripts/brain-slot-run.ts [slot]   (default slot 2)
 * Long-running (~1 min/event) — intended to run in the background.
 */
import { loadEnvConfig } from "@next/env";
import { getSupabase } from "../lib/supabase";
import { runBrain } from "../src/lib/ai-brain/run-brain";
import { saveBrainAnalysis } from "../src/lib/ai-brain/persist";
import { reviewWindow, daysSince, type Slot } from "../src/lib/slot";

const ACTIVE_MIN_DAYS = 7;

async function main() {
  loadEnvConfig(process.cwd());
  const slot = (Number(process.argv[2] ?? 2) as Slot);
  const today = new Date();
  const { dateFrom, dateTo } = reviewWindow(today); // last 7 full days ending yesterday

  const sb = getSupabase();
  const { data, error } = await sb
    .from("dca_campaign_ledger")
    .select("event_id,event_ids,event_name,status,campaign_start_date")
    .eq("review_slot", String(slot));
  if (error) throw new Error("ledger: " + error.message);

  type Row = { event_id: string; event_ids: string[] | null; event_name: string; status: string | null; campaign_start_date: string | null };
  const rows = (data ?? []) as Row[];
  const eligible = rows.filter(
    (r) => (r.status ?? "").toLowerCase() === "running" && (daysSince(r.campaign_start_date, today) ?? -1) >= ACTIVE_MIN_DAYS,
  );
  // Dedupe by primary event_id (festivals share a landing page).
  const seen = new Set<string>();
  const targets = eligible
    .map((r) => ({ id: r.event_ids?.[0] ?? r.event_id, name: r.event_name }))
    .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));

  console.log(`[fanout] slot ${slot} · window ${dateFrom}→${dateTo} · ${targets.length} eligible campaigns`);
  let ok = 0;
  const failures: { id: string; name: string; err: string }[] = [];
  const t0 = Date.now();

  for (let i = 0; i < targets.length; i++) {
    const { id, name } = targets[i];
    const label = `(${i + 1}/${targets.length}) ${id} ${name}`;
    const s = Date.now();
    try {
      const analysis = await runBrain(Number(id), dateFrom, dateTo);
      await saveBrainAnalysis(analysis, slot);
      ok++;
      console.log(`[ok]  ${label} → ${analysis.verdict.recommended_action} (primary ${analysis.verdict.primary_lens ?? "none"}) ${((Date.now() - s) / 1000).toFixed(0)}s`);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      failures.push({ id, name, err });
      console.log(`[FAIL] ${label} → ${err}`);
    }
  }

  console.log(`\n[fanout] DONE ${ok}/${targets.length} in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
  if (failures.length) {
    console.log("[fanout] failures:");
    for (const f of failures) console.log(`  ${f.id} ${f.name}: ${f.err}`);
  }
}

main().catch((e) => { console.error("SLOT_RUN_ERROR " + (e?.message ?? e)); process.exit(1); });
