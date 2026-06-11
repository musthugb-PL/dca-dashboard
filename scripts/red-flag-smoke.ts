/** Track B smoke — run the Red Flag detector locally, report hits. */
import { loadEnvConfig } from "@next/env";
import { runRedFlagDetection } from "../src/lib/data/red-flag-run";

async function main() {
  loadEnvConfig(process.cwd());
  const r = await runRedFlagDetection(new Date());

  console.log("================ RED FLAG RUN ================");
  console.log(`slot ${r.slot} · window ${r.dateFrom}→${r.dateTo}`);
  console.log(`campaigns scanned: ${r.scanned}`);
  console.log(`Red Flag hits:     ${r.hits}`);
  console.log(`by rule:`, JSON.stringify(r.byRule));
  console.log("\nsample hits:");
  for (const h of r.sample) {
    console.log(`  [${h.severity}] ${h.event_id} · ${h.rule_key} — ${h.message}`);
  }
}

main().catch((e) => { console.error("RF_SMOKE_ERROR " + (e?.message ?? e)); process.exit(1); });
