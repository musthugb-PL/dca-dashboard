/**
 * P2.2 single-event brain run → persist → read-back, behind the spend gate.
 *
 * Usage:  npx tsx scripts/brain-run-persist.ts [eventId] [slot]
 *   defaults: 106484 (Angham) slot 2.
 *
 * SPEND GATE: run ONE event at a time and review the rendered page before
 * fanning across a full slot.
 */
import { loadEnvConfig } from "@next/env";
import { runBrain } from "../src/lib/ai-brain/run-brain";
import {
  saveBrainAnalysis,
  getLatestBrainAnalysis,
  getBrainAnalysesForSlot,
} from "../src/lib/ai-brain/persist";
import { reviewWindow, type Slot } from "../src/lib/slot";

const EVENT_ID = Number(process.argv[2] ?? 106484);
const SLOT = (Number(process.argv[3] ?? 2) as Slot);

async function main() {
  loadEnvConfig(process.cwd());

  // Match the report page's window exactly (today-7 → today) so the rendered
  // KPI tiles and the AI diagnosis bullets describe the same 7 days.
  const today = new Date();
  const { dateFrom, dateTo } = reviewWindow(today); // last 7 full days ending yesterday

  console.log(`Running brain for ${EVENT_ID}, window ${dateFrom} → ${dateTo} (slot ${SLOT})…`);
  const t0 = Date.now();
  const analysis = await runBrain(EVENT_ID, dateFrom, dateTo);
  console.log(`Brain done in ${((Date.now() - t0) / 1000).toFixed(1)}s.\n`);

  await saveBrainAnalysis(analysis, SLOT);
  console.log("Persisted to dca_ai_analyses.\n");

  // --- read back: report-page path (latest by event_id) ---
  const latest = await getLatestBrainAnalysis(EVENT_ID);
  console.log("=== READ BACK (getLatestBrainAnalysis) ===");
  if (!latest) {
    console.error("FAIL: read-back returned null");
    process.exit(1);
  }
  console.log(`event ${latest.event_id} · generated ${latest.generated_at}`);
  console.log(`action: ${latest.verdict.recommended_action} · primary: ${latest.verdict.primary_lens} · confidence ${latest.verdict.confidence}`);
  for (const l of latest.lenses) {
    console.log(`\n[${l.lens}] score ${l.lens_score} (${l.severity}) · ${l.confidence}`);
    l.diagnosis_bullets.forEach((b) => console.log("   • " + b));
    console.log("   cluster: " + l.cluster_benchmark_used);
    console.log("   analog:  " + l.analog_event_cited);
  }
  console.log("\ntactical steps:");
  latest.verdict.tactical_steps.forEach((s) => console.log(`   ☐ [${s.channel}] ${s.text}`));
  console.log("\nstrategic context:", latest.verdict.strategic_context);
  console.log("expected outcome template:", latest.verdict.expected_outcome_template);

  // --- read back: dashboard-card path (today's slot map) ---
  const slotMap = await getBrainAnalysesForSlot(SLOT, [String(EVENT_ID)], today);
  console.log(`\n=== READ BACK (getBrainAnalysesForSlot slot ${SLOT}) === found: ${slotMap.has(String(EVENT_ID))}`);

  console.log("\nROUND-TRIP OK.");
}

main().catch((e) => {
  console.error("BRAIN_PERSIST_ERROR " + (e?.message ?? e));
  process.exit(1);
});
