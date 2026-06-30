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
  getEventCapacity,
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
  getAffinitySiblings,
  getOwnSegments,
  assembleInventory,
} from "./event-snapshot";
import { getPastDecisionsContext } from "./lens5";

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
  // --- P2.2 reference-data additions ---
  affinitySiblings?: AffinitySibling[]; // ref priority #3 — running co-purchase siblings
  pastDecisions?: PastDecisions; // Lens 5 — prior decisions/notes (multi-source + fuzzy name)
  ownSegments?: OwnSegments; // Fix 4 — this event's own ad-set top/bottom performers
  inventory?: Inventory; // STEP 3 FIX I — capacity / sold / pace / days-to-event urgency
};

export type ReportOptions = {
  includePrior?: boolean; // compute prior-7d snapshot + WoW deltas
  includeCluster?: boolean; // resolve dca_cluster_baselines row
  includeAnalogs?: boolean; // pull top-N similar events + their metrics
  includeAffinitySiblings?: boolean; // ref priority #3 — running affinity siblings + metrics
  includePastDecisions?: boolean; // Lens 5 — multi-source past-decision context
  includeOwnSegments?: boolean; // Fix 4 — this event's own ad-set granularity
  includeInventory?: boolean; // STEP 3 FIX I — capacity / sold / pace urgency
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
  // "exact" | "contains" | "adjacent-band" | "category-any-band" | null
  strategy: string | null;
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

/**
 * A high-performing ad set / audience / creative borrowed from a sibling, for
 * "test this pattern on YOUR campaign" recommendations (Sacred Rule #9: within-
 * event audience insight, never cross-event budget reallocation).
 * Meta has revenue → real ROAS; Google view has no revenue → roas stays null,
 * ranked by conversions instead.
 */
export type WinningSegment = {
  source: "meta" | "google";
  ad_name: string | null;
  campaign: string | null; // audience is inferred from the campaign name
  roas: number | null; // meta: purchase_value_aed / spend_aed; google: null
  spend_aed: number;
  conversions: number | null; // meta purchases / google conversions
  ctr: number | null;
};

/**
 * One of the CURRENT event's own ad sets / ads over the window (Fix 4), for
 * "kill ad set X, scale ad set Y" recommendations (within-event, Sacred Rule #9).
 * Meta: ad_name level w/ ROAS + frequency. Google: campaign+ad_group, no revenue
 * → roas null, ranked by conversions / cost-per-conversion.
 */
export type AdSet = {
  source: "meta" | "google";
  name: string; // ad_name (meta) or "campaign › ad_group" (google)
  campaign: string | null; // audience is encoded in the campaign name
  spend_aed: number;
  ctr: number | null;
  conversions: number | null; // meta custom_conversions / google conversions
  roas: number | null; // meta purchase_value_aed / spend; google null
  cpa: number | null; // spend / conversions (meta) or cost-per-conversion (google)
  frequency: number | null; // meta only (fatigue signal)
  conversion_rate: number | null; // google only
};

/** The current event's own segments: top performers + worst performers per channel. */
export type OwnSegments = {
  meta: { top: AdSet[]; bottom: AdSet[] };
  google: { top: AdSet[]; bottom: AdSet[] };
};

/**
 * CLAUDE.md reference-data priority #3: affinity siblings CURRENTLY RUNNING.
 * Co-purchase neighbours (dca_v_affinity) filtered to ledger status='running',
 * with each sibling's same-window metrics (same shape as AnalogEvent) PLUS their
 * top-performing segments (Fix 3) for borrow-the-winner recommendations.
 */
export type AffinitySibling = {
  event_id: string;
  name: string;
  affinity_norm: number; // co-purchase affinity score (higher = closer)
  sales_aed: number;
  spend_aed: number;
  tickets: number;
  roas: number;
  meta_ctr: number | null;
  google_ctr: number | null;
  winning_segments: WinningSegment[]; // top 2-3 Meta + Google segments (last 14d)
  /** STEP 3 FIX N — provenance:
   *   "running"        → dca_v_affinity, currently-running sibling (has live metrics)
   *   "past_copurchase"→ event_affinity_trough_users fallback (mostly PAST editions;
   *                       no live metrics — used as a warm-audience seed) */
  source: "running" | "past_copurchase";
  shared_users?: number | null; // past_copurchase only: # users who bought both
};

/** One past-decision/optimisation note matched to this event (Lens 5). */
export type PastDecisionItem = {
  source: "decisions" | "weekly_notes" | "source_b_notes" | "optimisation_notes";
  matched_by: "event_id" | "name";
  when: string | null; // review_date / week_of / week_label
  event_name: string | null;
  action: string | null; // final_action / action_taken (null for free-text notes)
  text: string; // reasoning / prediction / notes, concatenated + trimmed
  from_analog?: string; // set when borrowed from a similar event (Fix 12 fallback)
};

export type PastDecisions = {
  items: PastDecisionItem[];
  count: number;
  /** True when items come from similar events (this event has no own history). */
  viaAnalogs?: boolean;
};

export type PaceStatus = "ahead" | "on_track" | "behind" | "unknown";

/**
 * Inventory & urgency (STEP 3 FIX I). Capacity is an ESTIMATE from
 * GA4_marketing_share_by_channels.overall_capacity — it can be lower than
 * tickets actually sold (multi-category / resale), so `capacity_reliable` flags
 * when the denominator can't be trusted and pace is left "unknown". When there
 * is no capacity row at all, capacity stays null and pace is "unknown" → callers
 * fall back to non-urgency logic (Sacred Rule #11: never fabricate a number).
 */
export type Inventory = {
  capacity: number | null; // house capacity (estimate)
  sold: number; // all-time tickets sold (NOT the 7d window)
  remaining: number | null; // capacity - sold, clamped >= 0
  sold_pct: number | null; // sold / capacity (may exceed 100% → see capacity_reliable)
  capacity_reliable: boolean; // false when sold > capacity → denominator suspect
  days_to_event: number | null; // show date - today (negative = passed)
  sold_per_day_current: number; // window tickets / window days (recent run rate)
  sold_per_day_needed: number | null; // remaining / days_to_event (null if capacity/date unknown)
  pace_status: PaceStatus;
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
  if (opts.includeAffinitySiblings) {
    report.affinitySiblings = await getAffinitySiblings(eventId, dateFrom, dateTo);
  }
  if (opts.includePastDecisions) {
    report.pastDecisions = await getPastDecisionsContext(eventId, eventMeta.name);
  }
  if (opts.includeOwnSegments) {
    report.ownSegments = await getOwnSegments(eventId, dateFrom, dateTo);
  }
  if (opts.includeInventory) {
    const cap = await getEventCapacity(eventId);
    const windowDays = Math.max(1, Math.round((new Date(dateTo + "T00:00:00Z").getTime() - new Date(dateFrom + "T00:00:00Z").getTime()) / 86_400_000) + 1);
    report.inventory = assembleInventory(cap, eventMeta.date, sales.tickets_sold, windowDays);
  }

  return report;
}
