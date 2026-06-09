/** T4 review: full getEventReport for Russell Peters 104963, Jun 1-7. */
import { loadEnvConfig } from "@next/env";
import { getEventReport } from "../src/lib/data/events";

const E = 104963;
const FROM = "2026-06-01";
const TO = "2026-06-07";

const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
const n2 = (x: number) => x.toFixed(2);
const pct = (x: number) => (x * 100).toFixed(2) + "%";
const x1 = (x: number) => x.toFixed(1) + "x";

async function main() {
  loadEnvConfig(process.cwd());
  const r = await getEventReport(E, FROM, TO);

  console.log(`EVENT: ${r.event.name} | ${r.event.venue} | ${r.event.country} | status=${r.event.status} | date=${r.event.date}`);

  console.log("\n=== KPI STRIP === (screenshot: 16,961 / 871 / 46 / 369 / 2.09 / 19.5x)");
  console.log(
    `  Sales AED ${n0(r.kpis.total_sales_aed)} | Spend AED ${n0(r.kpis.total_spend_aed)} | ` +
      `Tickets ${r.kpis.tickets_sold} | AvgPrice ${n0(r.kpis.avg_ticket_price)} | ` +
      `AvgTix/Order ${r.kpis.avg_tickets_per_order.toFixed(2)} | ROAS ${x1(r.kpis.total_roas)}`,
  );

  console.log("\n=== ADS PERFORMANCE === (screenshot: 871 / 31,340 / 651 / 2.08% / 18 / 50 / 6,842 / 7.9x)");
  const a = r.ads_performance;
  console.log(
    `  Spend ${n0(a.spend)} | Impr ${n0(a.impressions)} | Clicks ${n0(a.clicks)} | CTR ${pct(a.ctr)} | ` +
      `Tickets ${n0(a.tickets)} | CPA ${n0(a.cpa)} | Revenue ${n0(a.revenue)} | ROAS ${x1(a.roas)}`,
  );

  console.log("\n=== CHANNELS ===");
  console.log("  (screenshot Meta: 64% / 557 / 4,626 / 13 / 44 / 8.3x)");
  console.log("  (screenshot Google: 36% / 314 / 2,217 / 5 / 63 / 7.1x)");
  for (const c of r.channels) {
    console.log(
      `  ${c.source.padEnd(8)} share ${pct(c.spend_share)} | spend ${n0(c.spend)} | ` +
        `rev ${n0(c.revenue)} | tickets ${n0(c.tickets)} (${n2(c.tickets)}) | ` +
        `CPA ${n0(c.cpa)} | ROAS ${x1(c.roas)} | CTR ${pct(c.ctr)}`,
    );
  }

  console.log("\n=== AD SETS (campaign x ad_group, channels_3) ===");
  for (const s of r.ad_sets) {
    console.log(
      `  [${s.platform}] ${s.campaign} / ${s.ad_group} :: spend ${n2(s.spend)} | ` +
        `tickets ${s.tickets} | CPA ${n2(s.cpa)} | ROAS ${x1(s.roas)} | CTR ${pct(s.ctr)}`,
    );
  }

  console.log("\n=== CAP / META DIAGNOSTIC ===");
  console.log(`  window cap_ratio = ${r.meta.cap_ratio.toFixed(3)} (1.0 = no cap)`);
  console.log(`  meta total tickets (raw) = ${n2(r.meta.attribution.total_meta_tickets)} | tiers:`);
  for (const c of r.meta.attribution.campaigns) {
    console.log(`    - ${c.campaign}: TIER ${c.tier_used}, firings ${c.cc_firings}, tickets ${n2(c.meta_tickets)}`);
  }

  console.log("\n=== FUNNEL ===");
  console.log(`  window: ${JSON.stringify(r.funnel.window)} (has_data depends on rows)`);
  console.log(`  benchmark_prior_365d lp->purchase: ${pct(r.funnel.benchmark_prior_365d.lp_to_purchase)}`);
}

main().catch((e) => {
  console.error("T4_ERROR " + (e?.message ?? String(e)));
  process.exit(1);
});
