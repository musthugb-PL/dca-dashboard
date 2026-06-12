/** P2.2 first-look: run the AI brain ONCE for Russell Peters 104963. */
import { loadEnvConfig } from "@next/env";
import { runBrain } from "../src/lib/ai-brain/run-brain";

async function main() {
  loadEnvConfig(process.cwd());
  const t0 = Date.now();
  const analysis = await runBrain(104963, "2026-06-01", "2026-06-07");
  console.log(`=== AI BRAIN · event 104963 · ${((Date.now() - t0) / 1000).toFixed(1)}s ===\n`);
  console.log("LENSES:");
  for (const l of analysis.lenses) {
    console.log(`\n[${l.lens}] score ${l.lens_score} (${l.severity}) · confidence ${l.confidence}`);
    l.diagnosis_bullets.forEach((b) => console.log("   • " + b));
    console.log("   cluster: " + l.cluster_benchmark_used);
    console.log("   analog:  " + l.analog_event_cited);
  }
  const v = analysis.verdict;
  console.log("\n=== VERDICT ===");
  console.log("primary lens:", v.primary_lens, "| contributing:", v.contributing_lenses.join(", "));
  console.log("ACTION:", v.recommended_action, "| confidence:", v.confidence);
  console.log("tactical steps:");
  v.tactical_steps.forEach((s) => console.log(`   ☐ [${s.channel}] ${s.text}`));
  console.log("strategic context:", v.strategic_context);
  console.log("expected outcome template:", v.expected_outcome_template);
}

main().catch((e) => { console.error("BRAIN_SMOKE_ERROR " + (e?.message ?? e)); process.exit(1); });
