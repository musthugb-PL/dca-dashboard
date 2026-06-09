/** T1 review: run the three bq-event functions against event 104963. */
import { loadEnvConfig } from "@next/env";
import {
  getEventSales,
  getChannelPerformance,
  getFunnel,
} from "../src/lib/data/bq-event";

const E = 104963;
const FROM = "2026-06-01";
const TO = "2026-06-07";

async function main() {
  loadEnvConfig(process.cwd());

  const sales = await getEventSales(E, FROM, TO);
  console.log("=== getEventSales ===");
  console.dir(sales, { depth: null });

  const channels = await getChannelPerformance(E, FROM, TO);
  console.log("\n=== getChannelPerformance ===");
  console.dir(channels, { depth: null });

  const funnel = await getFunnel(E, FROM, TO);
  console.log("\n=== getFunnel ===");
  console.dir(funnel, { depth: null });
}

main().catch((e) => {
  console.error("T1_ERROR " + (e?.message ?? String(e)));
  process.exit(1);
});
