/**
 * Phase 1b · BQ smoke test (CLAUDE.md Phase 1b Task 5).
 *
 * Loads .env.local (gitignored), runs ONE sanity query against the sales
 * truth table, prints the count. No secrets printed. Run with:
 *   npx tsx scripts/bq-smoke.ts
 */
import { loadEnvConfig } from "@next/env";
import { bq } from "../lib/bigquery";

async function main() {
  loadEnvConfig(process.cwd());

  const sql =
    "SELECT COUNT(*) AS n " +
    "FROM `platinumlist-1014.ai_dataset.completed_orders` " +
    "WHERE date BETWEEN '2026-05-28' AND '2026-06-04'";

  const rows = await bq.query<{ n: number | string | { value: string } }>(sql);
  const n = rows[0]?.n;
  const value = typeof n === "object" && n !== null ? (n as any).value : n;
  console.log("SMOKE_OK count=" + value);
}

main().catch((e) => {
  console.error("SMOKE_ERROR " + (e?.message ?? String(e)));
  process.exit(1);
});
