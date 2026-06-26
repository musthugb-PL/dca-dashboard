/**
 * Per-event BigQuery data layer (Phase 1b — data layer proof).
 *
 * CRITICAL ALIGNMENT RULE (CLAUDE.md): these functions must match the
 * Marketing Insights Dashboard inch-by-inch. Source-of-truth split:
 *   - Sales / tickets / orders / avg price / avg tickets-per-order
 *       → `completed_orders` ONLY.
 *   - Spend / impressions / clicks / CTR / CPC + Google/non-Meta
 *     tickets & revenue → `channels_3_campaign_level_llm` ONLY.
 *   - Funnel → `GA4_funnel_LP_table` ONLY.
 *
 * Meta tickets/revenue are NOT taken from channels.total_quantity — they
 * come from the CC 3-tier rule in meta.ts. See orchestrator (events.ts).
 *
 * Column notes (verified against INFORMATION_SCHEMA, 2026-06):
 *   - completed_orders: event key = `id_event` (INT64), date = `date`,
 *     AED revenue = `amount_aed` (FLOAT64).
 *   - channels_3_campaign_level_llm: event key = `event_id` (STRING),
 *     channel = `source`, impressions/clicks = BIGNUMERIC.
 *   - GA4_funnel_LP_table: event key = `event_id` (INT64), date =
 *     `session_date`. No literal `users_add_to_cart` column — the
 *     cart-equivalent stage is `users_on_ticket_office`.
 *
 * ── MID (Marketing Insights Dashboard) discrepancy — investigated 2026-06-26 ──
 * User saw Miami (105817) last-7d figures differ slightly vs marketing-insights.
 * Root cause is the WINDOW DEFINITION, not timezone or cap:
 *   - channels_3.date is a DATE (no time component) → no intra-day TZ ambiguity;
 *     a window difference is purely WHICH calendar dates are summed.
 *   - Our window = last 7 FULL days ending YESTERDAY (slot.ts reviewWindow).
 *     For 105817 on 2026-06-26 → 06-19..06-25: spend 1675, 28 tix, rev 9745.
 *   - Trailing 7d incl. today (06-20..06-26): spend 1441 (today partial + drops
 *     06-19). Calendar week Mon–Sun (06-22..28): spend 910 (week still in progress).
 *   So MID likely uses a calendar-week or trailing-7d-incl-today window → small
 *   deltas. Same source table, same CC attribution, same cap. The report page
 *   shows a provenance badge stating our exact window so the team can reconcile.
 *   (If exact MID parity is ever required, switch reviewWindow to MID's window.)
 */

import { bq, BQ_PROJECT, BQ_DATASET } from "@/lib/bigquery";

const T = (name: string) => `\`${BQ_PROJECT}.${BQ_DATASET}.${name}\``;

/** Coerce BigQuery numeric wrappers (Big / {value}) and nulls → number. */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "value" in v) {
    return Number((v as { value: unknown }).value);
  }
  return Number(v);
}

/** Coerce a BigQuery DATE ({value:'YYYY-MM-DD'}) or string → ISO date string. */
function dateStr(v: unknown): string {
  if (v && typeof v === "object" && "value" in v) {
    return String((v as { value: unknown }).value);
  }
  return String(v);
}

function safeDiv(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

// ---------------------------------------------------------------------------
// getEventSales — completed_orders (THE SALES TRUTH)
// ---------------------------------------------------------------------------

export type DailySales = { date: string; rev: number; tickets: number };

export type EventSales = {
  total_sales: number;
  tickets_sold: number;
  orders_count: number;
  avg_ticket_price: number;
  avg_tickets_per_order: number;
  daily: DailySales[];
};

export async function getEventSales(
  eventId: number,
  dateFrom: string,
  dateTo: string,
): Promise<EventSales> {
  const params = { eventId, dateFrom, dateTo };

  const [totals] = await bq.query<{
    total_sales: unknown;
    tickets_sold: unknown;
    orders_count: unknown;
  }>(
    `SELECT
        SUM(amount_aed)            AS total_sales,
        SUM(tickets_count)         AS tickets_sold,
        COUNT(DISTINCT id_order)   AS orders_count
     FROM ${T("completed_orders")}
     WHERE id_event = @eventId
       AND date BETWEEN DATE(@dateFrom) AND DATE(@dateTo)`,
    params,
  );

  const daily = await bq.query<{ date: unknown; rev: unknown; tickets: unknown }>(
    `SELECT
        date,
        SUM(amount_aed)    AS rev,
        SUM(tickets_count) AS tickets
     FROM ${T("completed_orders")}
     WHERE id_event = @eventId
       AND date BETWEEN DATE(@dateFrom) AND DATE(@dateTo)
     GROUP BY date
     ORDER BY date`,
    params,
  );

  const total_sales = num(totals?.total_sales);
  const tickets_sold = num(totals?.tickets_sold);
  const orders_count = num(totals?.orders_count);

  return {
    total_sales,
    tickets_sold,
    orders_count,
    // avg_ticket_price = SUM(amount_aed) / SUM(tickets_count)  (AED truth)
    avg_ticket_price: safeDiv(total_sales, tickets_sold),
    // avg_tickets_per_order = SUM(tickets_count) / COUNT(DISTINCT id_order)
    avg_tickets_per_order: safeDiv(tickets_sold, orders_count),
    daily: daily.map((r) => ({
      date: dateStr(r.date),
      rev: num(r.rev),
      tickets: num(r.tickets),
    })),
  };
}

// ---------------------------------------------------------------------------
// getChannelPerformance — channels_3_campaign_level_llm
// (Spend / impressions / clicks / CTR / CPC truth for ALL platforms.
//  total_quantity / total_revenue_aed are the truth for Google/non-Meta;
//  Meta tickets/revenue get overridden by meta.ts in the orchestrator.)
// ---------------------------------------------------------------------------

export type ChannelPerf = {
  source: string;
  spend_aed: number;
  impressions: number;
  clicks: number;
  total_quantity: number;
  total_revenue_aed: number;
  ctr: number; // ratio (clicks / impressions)
  cpc: number; // spend_aed / clicks
};

export type CampaignAdGroupPerf = ChannelPerf & {
  campaign: string;
  ad_group: string;
};

export type ChannelPerformance = {
  channels: ChannelPerf[];
  breakdown: CampaignAdGroupPerf[];
};

function withDerived<T extends Omit<ChannelPerf, "ctr" | "cpc">>(
  row: T,
): T & { ctr: number; cpc: number } {
  return {
    ...row,
    ctr: safeDiv(row.clicks, row.impressions),
    cpc: safeDiv(row.spend_aed, row.clicks),
  };
}

export async function getChannelPerformance(
  eventId: number,
  dateFrom: string,
  dateTo: string,
): Promise<ChannelPerformance> {
  const params = { eventId, dateFrom, dateTo };

  const channelRows = await bq.query<Record<string, unknown>>(
    `SELECT
        source,
        CAST(SUM(spend_aed)         AS FLOAT64) AS spend_aed,
        CAST(SUM(impressions)       AS INT64)   AS impressions,
        CAST(SUM(clicks)            AS INT64)   AS clicks,
        SUM(total_quantity)                     AS total_quantity,
        CAST(SUM(total_revenue_aed) AS FLOAT64) AS total_revenue_aed
     FROM ${T("channels_3_campaign_level_llm")}
     WHERE event_id = CAST(@eventId AS STRING)
       AND date BETWEEN DATE(@dateFrom) AND DATE(@dateTo)
     GROUP BY source
     ORDER BY spend_aed DESC`,
    params,
  );

  const breakdownRows = await bq.query<Record<string, unknown>>(
    `SELECT
        source,
        campaign,
        ad_group,
        CAST(SUM(spend_aed)         AS FLOAT64) AS spend_aed,
        CAST(SUM(impressions)       AS INT64)   AS impressions,
        CAST(SUM(clicks)            AS INT64)   AS clicks,
        SUM(total_quantity)                     AS total_quantity,
        CAST(SUM(total_revenue_aed) AS FLOAT64) AS total_revenue_aed
     FROM ${T("channels_3_campaign_level_llm")}
     WHERE event_id = CAST(@eventId AS STRING)
       AND date BETWEEN DATE(@dateFrom) AND DATE(@dateTo)
     GROUP BY source, campaign, ad_group
     ORDER BY spend_aed DESC`,
    params,
  );

  return {
    channels: channelRows.map((r) =>
      withDerived({
        source: String(r.source),
        spend_aed: num(r.spend_aed),
        impressions: num(r.impressions),
        clicks: num(r.clicks),
        total_quantity: num(r.total_quantity),
        total_revenue_aed: num(r.total_revenue_aed),
      }),
    ),
    breakdown: breakdownRows.map((r) => ({
      ...withDerived({
        source: String(r.source),
        spend_aed: num(r.spend_aed),
        impressions: num(r.impressions),
        clicks: num(r.clicks),
        total_quantity: num(r.total_quantity),
        total_revenue_aed: num(r.total_revenue_aed),
      }),
      campaign: String(r.campaign ?? ""),
      ad_group: String(r.ad_group ?? ""),
    })),
  };
}

// ---------------------------------------------------------------------------
// getFunnel — GA4_funnel_LP_table
// ---------------------------------------------------------------------------

export type FunnelStages = {
  users_on_lp: number;
  users_add_to_cart: number; // mapped from users_on_ticket_office (see note)
  users_with_checkout: number;
  users_with_purchase: number;
};

export type FunnelBenchmark = FunnelStages & {
  // conversion ratios across the prior-365d window, for context
  lp_to_cart: number;
  cart_to_checkout: number;
  checkout_to_purchase: number;
  lp_to_purchase: number;
};

export type Funnel = {
  window: FunnelStages;
  has_window_data: boolean;
  benchmark_prior_365d: FunnelBenchmark;
  has_benchmark_data: boolean;
  /**
   * `users_add_to_cart` note: GA4_funnel_LP_table has no literal
   * `users_add_to_cart` column. The cart-equivalent stage in this table is
   * `users_on_ticket_office`, which we use here. If a true add-to-cart count
   * is later needed, it must come from the GA4 Data API (events:
   * add_to_cart) — flagged as a future fallback, not wired in v1.
   */
  notes: string;
};

const FUNNEL_NOTE =
  "users_add_to_cart sourced from users_on_ticket_office (no literal " +
  "add_to_cart column in GA4_funnel_LP_table). True add_to_cart would " +
  "require the GA4 Data API — future fallback, not wired in v1.";

export async function getFunnel(
  eventId: number,
  dateFrom: string,
  dateTo: string,
): Promise<Funnel> {
  const [windowRow] = await bq.query<Record<string, unknown>>(
    `SELECT
        SUM(users_on_lp)            AS users_on_lp,
        SUM(users_on_ticket_office) AS users_add_to_cart,
        SUM(users_with_checkout)    AS users_with_checkout,
        SUM(users_with_purchase)    AS users_with_purchase
     FROM ${T("GA4_funnel_LP_table")}
     WHERE event_id = @eventId
       AND session_date BETWEEN DATE(@dateFrom) AND DATE(@dateTo)`,
    { eventId, dateFrom, dateTo },
  );

  const [benchRow] = await bq.query<Record<string, unknown>>(
    `SELECT
        SUM(users_on_lp)            AS users_on_lp,
        SUM(users_on_ticket_office) AS users_add_to_cart,
        SUM(users_with_checkout)    AS users_with_checkout,
        SUM(users_with_purchase)    AS users_with_purchase
     FROM ${T("GA4_funnel_LP_table")}
     WHERE event_id = @eventId
       AND session_date BETWEEN DATE_SUB(DATE(@dateFrom), INTERVAL 365 DAY)
                            AND DATE_SUB(DATE(@dateFrom), INTERVAL 1 DAY)`,
    { eventId, dateFrom },
  );

  const window: FunnelStages = {
    users_on_lp: num(windowRow?.users_on_lp),
    users_add_to_cart: num(windowRow?.users_add_to_cart),
    users_with_checkout: num(windowRow?.users_with_checkout),
    users_with_purchase: num(windowRow?.users_with_purchase),
  };

  const benchStages: FunnelStages = {
    users_on_lp: num(benchRow?.users_on_lp),
    users_add_to_cart: num(benchRow?.users_add_to_cart),
    users_with_checkout: num(benchRow?.users_with_checkout),
    users_with_purchase: num(benchRow?.users_with_purchase),
  };

  const has_window_data =
    windowRow?.users_on_lp !== null && windowRow?.users_on_lp !== undefined;
  const has_benchmark_data =
    benchRow?.users_on_lp !== null && benchRow?.users_on_lp !== undefined;

  return {
    window,
    has_window_data,
    benchmark_prior_365d: {
      ...benchStages,
      lp_to_cart: safeDiv(benchStages.users_add_to_cart, benchStages.users_on_lp),
      cart_to_checkout: safeDiv(
        benchStages.users_with_checkout,
        benchStages.users_add_to_cart,
      ),
      checkout_to_purchase: safeDiv(
        benchStages.users_with_purchase,
        benchStages.users_with_checkout,
      ),
      lp_to_purchase: safeDiv(
        benchStages.users_with_purchase,
        benchStages.users_on_lp,
      ),
    },
    has_benchmark_data,
    notes: FUNNEL_NOTE,
  };
}
