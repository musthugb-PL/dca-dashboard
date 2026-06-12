/**
 * P1.5 helpers for getEventReport: reusable window snapshot, WoW deltas,
 * cluster-baseline lookup, and similar-event analogs.
 *
 * computeSnapshot mirrors the validated current-window metric logic in
 * events.ts so prior/analog windows are computed identically.
 */

import { getEventSales, getChannelPerformance } from "./bq-event";
import { getMetaAttribution } from "./meta";
import { applyCap, summariseCappedBySource, type ChannelDailyRow } from "./cap";
import { bq, BQ_PROJECT, BQ_DATASET } from "@/lib/bigquery";
import { getSupabase } from "@/lib/supabase";
import type {
  ChannelReport,
  WindowSnapshot,
  Delta,
  WowDeltas,
  ClusterBaseline,
  AnalogEvent,
} from "./events";

const META_SOURCE_RE = /fb|facebook|instagram|meta/i;
const isMetaSource = (s: string) => META_SOURCE_RE.test(s);
const safeDiv = (n: number, d: number) => (d === 0 ? 0 : n / d);

/** Metric core for a window — mirrors the current-window logic in events.ts. */
export async function computeSnapshot(
  eventId: number,
  dateFrom: string,
  dateTo: string,
): Promise<WindowSnapshot> {
  const [sales, channelPerf, metaAttr] = await Promise.all([
    getEventSales(eventId, dateFrom, dateTo),
    getChannelPerformance(eventId, dateFrom, dateTo),
    getMetaAttribution(eventId, dateFrom, dateTo),
  ]);

  const metaChannels = channelPerf.channels.filter((c) => isMetaSource(c.source));
  const nonMetaChannels = channelPerf.channels.filter((c) => !isMetaSource(c.source));
  const metaSpend = metaChannels.reduce((s, c) => s + c.spend_aed, 0);
  const metaImpr = metaChannels.reduce((s, c) => s + c.impressions, 0);
  const metaClicks = metaChannels.reduce((s, c) => s + c.clicks, 0);
  const hasMeta = metaChannels.length > 0 || metaAttr.total_meta_tickets > 0;
  const totalSpend = channelPerf.channels.reduce((s, c) => s + c.spend_aed, 0);

  const WIN = `${dateFrom}..${dateTo}`;
  const META_KEY = "__meta__";
  const capRows: ChannelDailyRow[] = [];
  if (hasMeta)
    capRows.push({ date: WIN, source: META_KEY, raw_tickets: metaAttr.total_meta_tickets, raw_revenue: metaAttr.total_meta_revenue });
  for (const c of nonMetaChannels)
    capRows.push({ date: WIN, source: c.source, raw_tickets: c.total_quantity, raw_revenue: c.total_revenue_aed });
  const cap = applyCap(capRows, [{ date: WIN, total_tickets: sales.tickets_sold }]);
  const cappedBySource = summariseCappedBySource(cap);

  const channels: ChannelReport[] = [];
  if (hasMeta) {
    const capped = cappedBySource[META_KEY] ?? { capped_tickets: 0, capped_revenue: 0 };
    channels.push({
      source: "Meta", spend: metaSpend, impressions: metaImpr, clicks: metaClicks,
      ctr: safeDiv(metaClicks, metaImpr), tickets: capped.capped_tickets, revenue: capped.capped_revenue,
      cpa: safeDiv(metaSpend, capped.capped_tickets), roas: safeDiv(capped.capped_revenue, metaSpend),
      spend_share: safeDiv(metaSpend, totalSpend),
    });
  }
  for (const c of nonMetaChannels) {
    const capped = cappedBySource[c.source] ?? { capped_tickets: 0, capped_revenue: 0 };
    channels.push({
      source: c.source, spend: c.spend_aed, impressions: c.impressions, clicks: c.clicks, ctr: c.ctr,
      tickets: capped.capped_tickets, revenue: capped.capped_revenue,
      cpa: safeDiv(c.spend_aed, capped.capped_tickets), roas: safeDiv(capped.capped_revenue, c.spend_aed),
      spend_share: safeDiv(c.spend_aed, totalSpend),
    });
  }
  channels.sort((a, b) => b.spend - a.spend);

  const adsImpr = channelPerf.channels.reduce((s, c) => s + c.impressions, 0);
  const adsClicks = channelPerf.channels.reduce((s, c) => s + c.clicks, 0);
  const adsTickets = channels.reduce((s, c) => s + c.tickets, 0);
  const adsRevenue = channels.reduce((s, c) => s + c.revenue, 0);

  return {
    kpis: {
      total_sales_aed: sales.total_sales, total_spend_aed: totalSpend, tickets_sold: sales.tickets_sold,
      avg_ticket_price: sales.avg_ticket_price, avg_tickets_per_order: sales.avg_tickets_per_order,
      total_roas: safeDiv(sales.total_sales, totalSpend),
    },
    ads_performance: {
      spend: totalSpend, impressions: adsImpr, clicks: adsClicks, ctr: safeDiv(adsClicks, adsImpr),
      tickets: adsTickets, revenue: adsRevenue, cpa: safeDiv(totalSpend, adsTickets), roas: safeDiv(adsRevenue, totalSpend),
    },
    channels,
  };
}

function mkDelta(c: number, p: number): Delta {
  return { current: c, prior: p, pct: p !== 0 ? (c - p) / p : c > 0 ? 1 : 0 };
}

export function computeDeltas(cur: WindowSnapshot, prior: WindowSnapshot): WowDeltas {
  const findCh = (ch: ChannelReport[], name: string) =>
    ch.find((x) => x.source.toLowerCase() === name) ?? null;
  const cm = findCh(cur.channels, "meta"), pm = findCh(prior.channels, "meta");
  const cg = findCh(cur.channels, "google"), pg = findCh(prior.channels, "google");
  return {
    total_sales: mkDelta(cur.kpis.total_sales_aed, prior.kpis.total_sales_aed),
    total_spend: mkDelta(cur.kpis.total_spend_aed, prior.kpis.total_spend_aed),
    tickets: mkDelta(cur.kpis.tickets_sold, prior.kpis.tickets_sold),
    total_roas: mkDelta(cur.kpis.total_roas, prior.kpis.total_roas),
    ads_ctr: mkDelta(cur.ads_performance.ctr, prior.ads_performance.ctr),
    ads_roas: mkDelta(cur.ads_performance.roas, prior.ads_performance.roas),
    meta_ctr: cm && pm ? mkDelta(cm.ctr, pm.ctr) : null,
    meta_cpa: cm && pm ? mkDelta(cm.cpa, pm.cpa) : null,
    google_cpa: cg && pg ? mkDelta(cg.cpa, pg.cpa) : null,
  };
}

const priceBand = (price: number) => (price < 100 ? "low" : price < 400 ? "mid" : "high");

/** Resolve a cluster baseline by (event_category × price_band): exact → contains-fallback. */
export async function lookupClusterBaseline(
  eventId: number,
  avgTicketPrice: number,
): Promise<ClusterBaseline> {
  const sb = getSupabase();
  const band = priceBand(avgTicketPrice);

  let category = "";
  const led = await sb
    .from("dca_campaign_ledger")
    .select("event_category")
    .eq("event_id", String(eventId))
    .maybeSingle();
  category = String(led.data?.event_category ?? "").trim();
  if (!category) {
    const rows = await bq.query<{ category: string }>(
      `SELECT ANY_VALUE(category) AS category FROM \`${BQ_PROJECT}.${BQ_DATASET}.completed_orders\` WHERE id_event = @eventId`,
      { eventId },
    );
    category = String(rows[0]?.category ?? "").trim();
  }

  const empty: ClusterBaseline = {
    matched: false, strategy: null, event_category: category, price_band: band,
    cluster_category: null, cpa_p50: null, ctr_p50: null, roas_p50: null, sample_size: null,
  };
  if (!category) return empty;

  const { data } = await sb
    .from("dca_cluster_baselines")
    .select("event_category,cpa_p50,ctr_p50,roas_p50,sample_size")
    .eq("price_band", band);
  const rows = (data ?? []) as {
    event_category: string; cpa_p50: number; ctr_p50: number; roas_p50: number; sample_size: number;
  }[];

  const lc = category.toLowerCase();
  let match = rows.find((r) => r.event_category.trim().toLowerCase() === lc);
  let strategy: ClusterBaseline["strategy"] = match ? "exact" : null;
  if (!match) {
    const candidates = rows
      .filter((r) => r.event_category.toLowerCase().includes(lc))
      .sort((a, b) => (b.sample_size ?? 0) - (a.sample_size ?? 0));
    match = candidates[0];
    if (match) strategy = "contains";
  }
  if (!match) return empty;
  return {
    matched: true, strategy, event_category: category, price_band: band,
    cluster_category: match.event_category, cpa_p50: match.cpa_p50, ctr_p50: match.ctr_p50,
    roas_p50: match.roas_p50, sample_size: match.sample_size,
  };
}

/** Top-3 similar events + each one's metrics for the same window. */
export async function getAnalogs(
  eventId: number,
  dateFrom: string,
  dateTo: string,
): Promise<AnalogEvent[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from("dca_v_similar_events")
    .select("similar_event_id,rank,combined_score")
    .eq("event_id", String(eventId))
    .order("rank")
    .limit(3);
  const sims = (data ?? []) as { similar_event_id: string; rank: number; combined_score: number }[];
  if (!sims.length) return [];

  const ids = sims.map((s) => Number(s.similar_event_id)).filter((n) => Number.isFinite(n));
  const nameRows = await bq.query<{ id_event: number; name: string }>(
    `SELECT id_event, ANY_VALUE(event_name) AS name FROM \`${BQ_PROJECT}.${BQ_DATASET}.completed_orders\` WHERE id_event IN UNNEST(@ids) GROUP BY id_event`,
    { ids },
  );
  const nameMap = new Map(nameRows.map((r) => [String(r.id_event), String(r.name)]));

  const out: AnalogEvent[] = [];
  for (const s of sims) {
    try {
      const snap = await computeSnapshot(Number(s.similar_event_id), dateFrom, dateTo);
      const meta = snap.channels.find((c) => c.source.toLowerCase() === "meta") ?? null;
      const google = snap.channels.find((c) => c.source.toLowerCase() === "google") ?? null;
      out.push({
        event_id: s.similar_event_id, rank: s.rank, score: s.combined_score,
        name: nameMap.get(s.similar_event_id) ?? "",
        sales_aed: snap.kpis.total_sales_aed, spend_aed: snap.kpis.total_spend_aed,
        tickets: snap.ads_performance.tickets, roas: snap.kpis.total_roas,
        meta_ctr: meta ? meta.ctr : null, google_ctr: google ? google.ctr : null,
      });
    } catch {
      /* skip analogs that error */
    }
  }
  return out;
}
