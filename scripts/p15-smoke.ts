/** P1.5 smoke: regression check (validated window) + new extensions (this week + prior). */
import { loadEnvConfig } from "@next/env";
import { getEventReport } from "../src/lib/data/events";

const E = 104963;
const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
const pct = (x: number) => (x * 100).toFixed(2) + "%";
const x1 = (x: number) => x.toFixed(1) + "x";

async function main() {
  loadEnvConfig(process.cwd());

  // ---- 1. REGRESSION CHECK on the validated screenshot window ----
  const r = await getEventReport(E, "2026-06-01", "2026-06-07");
  const a = r.ads_performance;
  const meta = r.channels.find((c) => c.source === "Meta");
  const google = r.channels.find((c) => c.source.toLowerCase() === "google");
  console.log("=== REGRESSION CHECK 2026-06-01→07 (screenshot: 16,961/871/46/369/2.09/19.5x) ===");
  console.log(`  KPI: sales ${n0(r.kpis.total_sales_aed)} | spend ${n0(r.kpis.total_spend_aed)} | tickets ${r.kpis.tickets_sold} | price ${n0(r.kpis.avg_ticket_price)} | t/o ${r.kpis.avg_tickets_per_order.toFixed(2)} | ROAS ${x1(r.kpis.total_roas)}`);
  console.log(`  ADS: spend ${n0(a.spend)} | impr ${n0(a.impressions)} | clicks ${n0(a.clicks)} | CTR ${pct(a.ctr)} | tickets ${n0(a.tickets)} | CPA ${n0(a.cpa)} | rev ${n0(a.revenue)} | ROAS ${x1(a.roas)}  (screenshot 871/31,340/651/2.08%/18/50/6,842/7.9x)`);
  console.log(`  Meta:   ${pct(meta!.spend_share)} | spend ${n0(meta!.spend)} | rev ${n0(meta!.revenue)} | tix ${n0(meta!.tickets)} | CPA ${n0(meta!.cpa)} | ${x1(meta!.roas)}  (screenshot 64%/557/4,626/13/44/8.3x)`);
  console.log(`  Google: ${pct(google!.spend_share)} | spend ${n0(google!.spend)} | rev ${n0(google!.revenue)} | tix ${n0(google!.tickets)} | CPA ${n0(google!.cpa)} | ${x1(google!.roas)}  (screenshot 36%/314/2,217/5/63/7.1x)`);

  // ---- 2. P1.5 EXTENSIONS on this-week window (prior auto = 2026-05-27→06-02) ----
  const p = await getEventReport(E, "2026-06-03", "2026-06-09", {
    includePrior: true,
    includeCluster: true,
    includeAnalogs: true,
  });
  console.log("\n=== P1.5 — current 2026-06-03→09 vs prior 2026-05-27→06-02 ===");
  console.log("  metric        current      prior        WoW");
  const row = (label: string, cur: string, prior: string, d?: { pct: number }) =>
    console.log(`  ${label.padEnd(12)} ${cur.padEnd(12)} ${prior.padEnd(12)} ${d ? (d.pct * 100).toFixed(1) + "%" : ""}`);
  row("sales", n0(p.kpis.total_sales_aed), n0(p.prior!.kpis.total_sales_aed), p.deltas!.total_sales);
  row("spend", n0(p.kpis.total_spend_aed), n0(p.prior!.kpis.total_spend_aed), p.deltas!.total_spend);
  row("tickets", String(p.kpis.tickets_sold), String(p.prior!.kpis.tickets_sold), p.deltas!.tickets);
  row("total ROAS", x1(p.kpis.total_roas), x1(p.prior!.kpis.total_roas), p.deltas!.total_roas);
  row("ads CTR", pct(p.ads_performance.ctr), pct(p.prior!.ads_performance.ctr), p.deltas!.ads_ctr);
  row("ads ROAS", x1(p.ads_performance.roas), x1(p.prior!.ads_performance.roas), p.deltas!.ads_roas);
  if (p.deltas!.meta_ctr) row("meta CTR", pct(p.deltas!.meta_ctr.current), pct(p.deltas!.meta_ctr.prior), p.deltas!.meta_ctr);

  console.log("\n  Cluster baseline:");
  console.dir(p.clusterBaseline, { depth: null });

  console.log("\n  Analogs (top-3):");
  for (const an of p.analogs ?? []) {
    console.log(`    #${an.rank} ${an.event_id} "${an.name}" — score ${an.score.toFixed(3)} | sales ${n0(an.sales_aed)} | spend ${n0(an.spend_aed)} | tix ${n0(an.tickets)} | ROAS ${x1(an.roas)} | metaCTR ${an.meta_ctr === null ? "n/a" : pct(an.meta_ctr)} | googleCTR ${an.google_ctr === null ? "n/a" : pct(an.google_ctr)}`);
  }
}

main().catch((e) => { console.error("P15_SMOKE_ERROR " + (e?.message ?? e)); process.exit(1); });
