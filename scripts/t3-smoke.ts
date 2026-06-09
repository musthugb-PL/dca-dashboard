/** T3 review: build real daily channel rows for event 104963, apply the cap. */
import { loadEnvConfig } from "@next/env";
import { getSupabase } from "../lib/supabase";
import { bq, BQ_PROJECT, BQ_DATASET } from "../lib/bigquery";
import { getEventSales } from "../src/lib/data/bq-event";
import { applyCap, summariseCappedBySource, type ChannelDailyRow } from "../src/lib/data/cap";

const E = 104963;
const FROM = "2026-06-01";
const TO = "2026-06-07";
const META_CAMPAIGN = "Russell-Peters_104963_UAE_CC_3Jun";
const META_PRIMARY_LABEL = "Russell Peters 104963 Custom Conversions";

async function main() {
  loadEnvConfig(process.cwd());

  const sales = await getEventSales(E, FROM, TO);
  const aTPO = sales.avg_tickets_per_order;
  const aTP = sales.avg_ticket_price;
  const salesByDay = sales.daily.map((d) => ({ date: d.date, total_tickets: d.tickets }));

  // Meta daily: primary-label CC firings per day × avg_tickets_per_order
  const sb = getSupabase();
  const { data: cc } = await sb
    .from("dca_v_meta_custom_conversions")
    .select("date, custom_conversions")
    .eq("campaign", META_CAMPAIGN)
    .eq("custom_conversion_label", META_PRIMARY_LABEL)
    .gte("date", FROM)
    .lte("date", TO);
  const metaFiringsByDay = new Map<string, number>();
  for (const r of cc ?? []) {
    const d = String(r.date);
    metaFiringsByDay.set(d, (metaFiringsByDay.get(d) ?? 0) + Number(r.custom_conversions ?? 0));
  }

  // Google daily: channels_3 total_quantity + total_revenue_aed per day
  const gRows = await bq.query<{ date: unknown; qty: unknown; rev: unknown }>(
    `SELECT date, SUM(total_quantity) AS qty,
            CAST(SUM(total_revenue_aed) AS FLOAT64) AS rev
       FROM \`${BQ_PROJECT}.${BQ_DATASET}.channels_3_campaign_level_llm\`
      WHERE event_id = CAST(@e AS STRING) AND source = 'google'
        AND date BETWEEN DATE(@f) AND DATE(@t)
      GROUP BY date ORDER BY date`,
    { e: E, f: FROM, t: TO },
  );

  // Build per-channel per-day rows
  const rows: ChannelDailyRow[] = [];
  for (const [date, firings] of Array.from(metaFiringsByDay)) {
    const tickets = firings * aTPO;
    rows.push({ date, source: "fb & instagram", raw_tickets: tickets, raw_revenue: tickets * aTP });
  }
  for (const r of gRows) {
    const date = (r.date as { value: string }).value;
    const tickets = Number(r.qty ?? 0);
    rows.push({ date, source: "google", raw_tickets: tickets, raw_revenue: Number(r.rev ?? 0) });
  }

  const result = applyCap(rows, salesByDay);

  console.log("=== per-day cap ===");
  for (const d of result.capByDay) {
    console.log(
      `  ${d.date}  actual=${d.total_tickets}  raw_mkt=${d.raw_marketing_tickets.toFixed(2)}  ` +
        `cap_ratio=${d.cap_ratio.toFixed(3)}  ${d.capped ? "<<< CAP FIRED" : ""}`,
    );
  }

  const rawMeta = rows.filter((r) => r.source === "fb & instagram").reduce((s, r) => s + r.raw_tickets, 0);
  const rawGoogle = rows.filter((r) => r.source === "google").reduce((s, r) => s + r.raw_tickets, 0);
  const capped = summariseCappedBySource(result);

  console.log("\n=== totals (raw → capped) ===");
  console.log(`  Meta tickets:   raw ${rawMeta.toFixed(2)} → capped ${capped["fb & instagram"]?.capped_tickets.toFixed(2)}`);
  console.log(`  Google tickets: raw ${rawGoogle.toFixed(2)} → capped ${capped["google"]?.capped_tickets.toFixed(2)}`);
  console.log(`  Meta revenue:   capped ${capped["fb & instagram"]?.capped_revenue.toFixed(2)}`);
  console.log(`  Google revenue: capped ${capped["google"]?.capped_revenue.toFixed(2)}`);
  console.log(`  Actual tickets sold (week): ${sales.tickets_sold}`);
}

main().catch((e) => {
  console.error("T3_ERROR " + (e?.message ?? String(e)));
  process.exit(1);
});
