/**
 * Per-event report orchestrator (Phase 1b data-layer proof).
 *
 * getEventReport merges:
 *   T1  bq-event.ts  → sales (completed_orders) + channel spend/impr/clicks
 *                      (channels_3) + funnel (GA4_funnel_LP_table)
 *   T2  meta.ts      → Meta tickets/revenue via the CC 3-tier rule
 *   T3  cap.ts       → window-level attribution cap
 *
 * Mirrors the Marketing Insights Dashboard per-event view. Source-of-truth
 * split per CLAUDE.md CRITICAL ALIGNMENT RULE:
 *   - KPIs / sales            → completed_orders
 *   - spend/impr/clicks/CTR   → channels_3 (ALL platforms)
 *   - Meta tickets/revenue    → CC 3-tier (meta.ts), NOT channels.total_quantity
 *   - Google/non-Meta t/r     → channels_3 total_quantity / total_revenue_aed
 *   - funnel                  → GA4_funnel_LP_table
 *
 * Capping note: the decision-card KPI strip + Channel Performance summary use
 * WINDOW-LEVEL capping (one row per channel over the whole window), per the
 * Marketing Insights Dashboard Notion doc. applyCap() is granularity-agnostic
 * — feed it per-day rows instead for the (Phase 2) daily timeseries chart.
 */

import {
  getEventSales,
  getChannelPerformance,
  getFunnel,
  type Funnel,
  type DailySales,
} from "./bq-event";
import { getMetaAttribution, type MetaAttribution } from "./meta";
import { applyCap, summariseCappedBySource, type ChannelDailyRow } from "./cap";
import { bq, BQ_PROJECT, BQ_DATASET } from "@/lib/bigquery";
import { isoDate, addDays } from "@/src/lib/slot";
import {
  computeSnapshot,
  computeDeltas,
  lookupClusterBaseline,
  getAnalogs,
} from "./event-snapshot";

/** Channel-name test for Meta sources in channels_3 (e.g. "fb & instagram"). */
const META_SOURCE_RE = /fb|facebook|instagram|meta/i;
const isMetaSource = (s: string) => META_SOURCE_RE.test(s);

function safeDiv(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventMeta = {
  id: number;
  name: string;
  venue: string;
  country: string;
  city: string;
  date: string | null; // show datetime (ISO) from completed_orders
  status: string;
};

export type ChannelReport = {
  source: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  tickets: number; // capped
  revenue: number; // capped
  cpa: number; // spend / tickets
  roas: number; // revenue / spend
  spend_share: number; // spend / total spend
};

export type AdSetReport = {
  platform: string;
  campaign: string;
  ad_group: string;
  spend: number;
  tickets: number;
  cpa: number;
  roas: number;
  ctr: number;
};

export type EventReport = {
  event: EventMeta;
  kpis: {
    total_sales_aed: number;
    total_spend_aed: number;
    tickets_sold: number;
    avg_ticket_price: number;
    avg_tickets_per_order: number;
    total_roas: number; // total_sales / total_spend (the 19.5x strip KPI)
  };
  sales: {
    total_sales_aed: number;
    tickets_sold: number;
    orders_count: number;
    avg_ticket_price: number;
    avg_tickets_per_order: number;
    daily: DailySales[];
  };
  ads_performance: {
    spend: number;
    impressions: number;
    clicks: number;
    ctr: number;
    tickets: number; // capped, summed across channels
    revenue: number; // capped, summed across channels
    cpa: number;
    roas: number;
  };
  channels: ChannelReport[];
  ad_sets: AdSetReport[];
  funnel: { window: Funnel["window"]; benchmark_prior_365d: Funnel["benchmark_prior_365d"] };
  meta: {
    cap_ratio: number; // window-level cap applied to attribution (1.0 = none)
    attribution: MetaAttribution; // full Tier 1/2/3 diagnostic
  };
  // --- P1.5 extensions (only present when requested via ReportOptions) ---
  prior?: WindowSnapshot; // same metrics for the prior 7d window
  deltas?: WowDeltas; // week-over-week deltas (current vs prior)
  clusterBaseline?: ClusterBaseline | null;
  analogs?: AnalogEvent[];
};

export type ReportOptions = {
  includePrior?: boolean; // compute prior-7d snapshot + WoW deltas
  includeCluster?: boolean; // resolve dca_cluster_baselines row
  includeAnalogs?: boolean; // pull top-N similar events + their metrics
};

export type KpiBlock = EventReport["kpis"];
export type AdsBlock = EventReport["ads_performance"];

/** The metric core of a window — reused for current, prior, and analogs. */
export type WindowSnapshot = {
  kpis: KpiBlock;
  ads_performance: AdsBlock;
  channels: ChannelReport[];
};

export type Delta = { current: number; prior: number; pct: number }; // pct = (cur-prior)/prior

export type WowDeltas = {
  total_sales: Delta;
  total_spend: Delta;
  tickets: Delta;
  total_roas: Delta;
  ads_ctr: Delta;
  ads_roas: Delta;
  meta_ctr: Delta | null;
  meta_cpa: Delta | null;
  google_cpa: Delta | null;
};

export type ClusterBaseline = {
  matched: boolean;
  strategy: "exact" | "contains" | null;
  event_category: string; // the event's category used for lookup
  price_band: string;
  cluster_category: string | null; // the matched cluster's category
  cpa_p50: number | null;
  ctr_p50: number | null;
  roas_p50: number | null;
  sample_size: number | null;
};

export type AnalogEvent = {
  event_id: string;
  rank: number;
  score: number;
  name: string;
  sales_aed: number;
  spend_aed: number;
  tickets: number;
  roas: number;
  meta_ctr: number | null;
  google_ctr: number | null;
};

// ---------------------------------------------------------------------------
// Event metadata (completed_orders)
// ---------------------------------------------------------------------------

async function getEventMeta(eventId: number): Promise<EventMeta> {
  const [row] = await bq.query<Record<string, unknown>>(
    `SELECT
        ANY_VALUE(event_name)   AS name,
        ANY_VALUE(venue)        AS venue,
        ANY_VALUE(country)      AS country,
        ANY_VALUE(city)         AS city,
        ANY_VALUE(event_status) AS status,
        MIN(start_datetime_min) AS event_dt
     FROM \`${BQ_PROJECT}.${BQ_DATASET}.completed_orders\`
     WHERE id_event = @eventId`,
    { eventId },
  );
  const dt = row?.event_dt as { value?: string } | null | undefined;
  return {
    id: eventId,
    name: String(row?.name ?? ""),
    venue: String(row?.venue ?? ""),
    country: String(row?.country ?? ""),
    city: String(row?.city ?? ""),
    date: dt && dt.value ? dt.value : null,
    status: String(row?.status ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function getEventReport(
  eventId: number,
  dateFrom: string,
  dateTo: string,
  opts: ReportOptions = {},
): Promise<EventReport> {
  const [sales, channelPerf, funnel, metaAttr, eventMeta] = await Promise.all([
    getEventSales(eventId, dateFrom, dateTo),
    getChannelPerformance(eventId, dateFrom, dateTo),
    getFunnel(eventId, dateFrom, dateTo),
    getMetaAttribution(eventId, dateFrom, dateTo),
    getEventMeta(eventId),
  ]);

  // --- Split channels_3 sources into Meta (aggregated) vs non-Meta ---
  const metaChannels = channelPerf.channels.filter((c) => isMetaSource(c.source));
  const nonMetaChannels = channelPerf.channels.filter((c) => !isMetaSource(c.source));

  const metaSpend = metaChannels.reduce((s, c) => s + c.spend_aed, 0);
  const metaImpr = metaChannels.reduce((s, c) => s + c.impressions, 0);
  const metaClicks = metaChannels.reduce((s, c) => s + c.clicks, 0);
  const hasMeta = metaChannels.length > 0 || metaAttr.total_meta_tickets > 0;

  const totalSpend = channelPerf.channels.reduce((s, c) => s + c.spend_aed, 0);

  // --- Build WINDOW-LEVEL rows for the cap (one synthetic "day") ---
  const WIN = `${dateFrom}..${dateTo}`;
  const META_KEY = "__meta__";
  const capRows: ChannelDailyRow[] = [];
  if (hasMeta) {
    capRows.push({
      date: WIN,
      source: META_KEY,
      raw_tickets: metaAttr.total_meta_tickets, // CC-attributed, raw float
      raw_revenue: metaAttr.total_meta_revenue,
    });
  }
  for (const c of nonMetaChannels) {
    capRows.push({
      date: WIN,
      source: c.source,
      raw_tickets: c.total_quantity, // channels_3 truth for non-Meta
      raw_revenue: c.total_revenue_aed,
    });
  }
  const cap = applyCap(capRows, [{ date: WIN, total_tickets: sales.tickets_sold }]);
  const cappedBySource = summariseCappedBySource(cap);
  const cap_ratio = cap.capByDay[0]?.cap_ratio ?? 1;

  // --- Assemble channel reports ---
  const channels: ChannelReport[] = [];
  if (hasMeta) {
    const capped = cappedBySource[META_KEY] ?? { capped_tickets: 0, capped_revenue: 0 };
    channels.push({
      source: "Meta",
      spend: metaSpend,
      impressions: metaImpr,
      clicks: metaClicks,
      ctr: safeDiv(metaClicks, metaImpr),
      tickets: capped.capped_tickets,
      revenue: capped.capped_revenue,
      cpa: safeDiv(metaSpend, capped.capped_tickets),
      roas: safeDiv(capped.capped_revenue, metaSpend),
      spend_share: safeDiv(metaSpend, totalSpend),
    });
  }
  for (const c of nonMetaChannels) {
    const capped = cappedBySource[c.source] ?? { capped_tickets: 0, capped_revenue: 0 };
    channels.push({
      source: c.source,
      spend: c.spend_aed,
      impressions: c.impressions,
      clicks: c.clicks,
      ctr: c.ctr,
      tickets: capped.capped_tickets,
      revenue: capped.capped_revenue,
      cpa: safeDiv(c.spend_aed, capped.capped_tickets),
      roas: safeDiv(capped.capped_revenue, c.spend_aed),
      spend_share: safeDiv(c.spend_aed, totalSpend),
    });
  }
  // biggest spenders first
  channels.sort((a, b) => b.spend - a.spend);

  // --- ads_performance = capped sum across channels ---
  const adsSpend = totalSpend;
  const adsImpr = channelPerf.channels.reduce((s, c) => s + c.impressions, 0);
  const adsClicks = channelPerf.channels.reduce((s, c) => s + c.clicks, 0);
  const adsTickets = channels.reduce((s, c) => s + c.tickets, 0);
  const adsRevenue = channels.reduce((s, c) => s + c.revenue, 0);

  // --- ad_sets (campaign × ad_group breakdown from channels_3) ---
  // Note: Meta ad-set tickets use channels_3 total_quantity (CC firings are
  // not reliably ad_group-granular). Headline Meta tickets above use CC.
  const ad_sets: AdSetReport[] = channelPerf.breakdown.map((b) => ({
    platform: b.source,
    campaign: b.campaign,
    ad_group: b.ad_group,
    spend: b.spend_aed,
    tickets: b.total_quantity,
    cpa: safeDiv(b.spend_aed, b.total_quantity),
    roas: safeDiv(b.total_revenue_aed, b.spend_aed),
    ctr: b.ctr,
  }));

  const report: EventReport = {
    event: eventMeta,
    kpis: {
      total_sales_aed: sales.total_sales,
      total_spend_aed: totalSpend,
      tickets_sold: sales.tickets_sold,
      avg_ticket_price: sales.avg_ticket_price,
      avg_tickets_per_order: sales.avg_tickets_per_order,
      total_roas: safeDiv(sales.total_sales, totalSpend),
    },
    sales: {
      total_sales_aed: sales.total_sales,
      tickets_sold: sales.tickets_sold,
      orders_count: sales.orders_count,
      avg_ticket_price: sales.avg_ticket_price,
      avg_tickets_per_order: sales.avg_tickets_per_order,
      daily: sales.daily,
    },
    ads_performance: {
      spend: adsSpend,
      impressions: adsImpr,
      clicks: adsClicks,
      ctr: safeDiv(adsClicks, adsImpr),
      tickets: adsTickets,
      revenue: adsRevenue,
      cpa: safeDiv(adsSpend, adsTickets),
      roas: safeDiv(adsRevenue, adsSpend),
    },
    channels,
    ad_sets,
    funnel: {
      window: funnel.window,
      benchmark_prior_365d: funnel.benchmark_prior_365d,
    },
    meta: { cap_ratio, attribution: metaAttr },
  };

  // --- P1.5 extensions (opt-in; dashboard omits them to stay fast) ---
  if (opts.includePrior) {
    const anchor = new Date(dateFrom + "T00:00:00");
    const priorFrom = isoDate(addDays(anchor, -7));
    const priorTo = isoDate(addDays(anchor, -1));
    const prior = await computeSnapshot(eventId, priorFrom, priorTo);
    report.prior = { kpis: prior.kpis, ads_performance: prior.ads_performance, channels: prior.channels };
    report.deltas = computeDeltas(
      { kpis: report.kpis, ads_performance: report.ads_performance, channels },
      report.prior,
    );
  }
  if (opts.includeCluster) {
    report.clusterBaseline = await lookupClusterBaseline(eventId, sales.avg_ticket_price);
  }
  if (opts.includeAnalogs) {
    report.analogs = await getAnalogs(eventId, dateFrom, dateTo);
  }

  return report;
}
