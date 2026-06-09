/** T2 review: Meta 3-tier attribution for event 104963. */
import { loadEnvConfig } from "@next/env";
import { getMetaAttribution } from "../src/lib/data/meta";

const E = 104963;
const FROM = "2026-06-01";
const TO = "2026-06-07";

async function main() {
  loadEnvConfig(process.cwd());
  const res = await getMetaAttribution(E, FROM, TO);

  console.log("event_id:", res.event_id);
  console.log("avg_tickets_per_order:", res.avg_tickets_per_order.toFixed(4));
  console.log("avg_ticket_price:", res.avg_ticket_price.toFixed(2));
  console.log("\nper-campaign:");
  for (const c of res.campaigns) {
    console.log(
      `  • ${c.campaign}\n` +
        `      matched_via=${c.matched_via}  TIER=${c.tier_used}  ` +
        `primary_label="${c.primary_label}"\n` +
        `      cc_firings=${c.cc_firings}  meta_tickets=${c.meta_tickets.toFixed(2)} ` +
        `(round ${Math.round(c.meta_tickets)})  meta_revenue=${c.meta_revenue.toFixed(2)}`,
    );
  }
  console.log(
    "\nTOTAL meta_tickets=",
    res.total_meta_tickets.toFixed(2),
    "(round " + Math.round(res.total_meta_tickets) + ")",
  );
  console.log("TOTAL meta_revenue=", res.total_meta_revenue.toFixed(2));
}

main().catch((e) => {
  console.error("T2_ERROR " + (e?.message ?? String(e)));
  process.exit(1);
});
