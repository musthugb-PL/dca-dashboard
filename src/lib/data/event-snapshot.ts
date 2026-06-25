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
import { isoDate, addDays } from "@/src/lib/slot";
import type {
  ChannelReport,
  WindowSnapshot,
  Delta,
  WowDeltas,
  ClusterBaseline,
  AnalogEvent,
  AffinitySibling,
  WinningSegment,
  AdSet,
  OwnSegments,
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
const ADJACENT_BANDS: Record<string, string[]> = { low: ["mid"], mid: ["low", "high"], high: ["mid"] };

// Generic words dropped before token-matching a category (keep distinctive ones
// like "arabic", "comedy", "desi", "classical", "gaming").
const CAT_STOPWORDS = new Set(["events", "event", "shows", "show", "and", "the", "live"]);
function categoryTokens(cat: string): string[] {
  return Array.from(
    new Set(
      cat.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !CAT_STOPWORDS.has(t)),
    ),
  );
}

type ClusterRow = {
  event_category: string;
  price_band: string;
  cpa_p50: number;
  ctr_p50: number;
  roas_p50: number;
  sample_size: number;
};

const dbg = (...a: unknown[]) => {
  if (process.env.LENS_DEBUG === "1") console.log("[cluster]", ...a);
};

/**
 * Resolve a cluster baseline with a broad fallback ladder, picking the largest
 * sample_size among candidates at the first rung that matches:
 *   1. exact category (ledger OR completed_orders) × target price_band
 *   2. token-contains (any category token) × target band  ("Arabic Pop" → "Arabic Events")
 *   3. exact OR token-contains × adjacent band (low↔mid, mid↔high)
 *   4. token-contains × ANY band  (last resort)
 * Set LENS_DEBUG=1 to trace category resolution + candidate rows.
 */
export async function lookupClusterBaseline(
  eventId: number,
  avgTicketPrice: number,
): Promise<ClusterBaseline> {
  const sb = getSupabase();
  const band = priceBand(avgTicketPrice);

  // Resolve category from three sources, in cluster-key priority order:
  //   1. ledger event_category  (Sacred Rule #8 — THE cluster key)
  //   2. dca_v_events.categories (authoritative categories field; NOT marketing_tags)
  //   3. completed_orders.category (generic, e.g. "Concerts" — last resort)
  // All non-empty values seed the ladder; maxSample then prefers the best row.
  let ledgerCat = "";
  const led = await sb
    .from("dca_campaign_ledger")
    .select("event_category")
    .eq("event_id", String(eventId))
    .maybeSingle();
  ledgerCat = String(led.data?.event_category ?? "").trim();

  let eventsCat = "";
  const ev = await sb
    .from("dca_v_events")
    .select("categories")
    .eq("event_id", String(eventId))
    .maybeSingle();
  eventsCat = String(ev.data?.categories ?? "").trim();

  let ordersCat = "";
  try {
    const rows = await bq.query<{ category: string }>(
      `SELECT ANY_VALUE(category) AS category FROM \`${BQ_PROJECT}.${BQ_DATASET}.completed_orders\` WHERE id_event = @eventId`,
      { eventId },
    );
    ordersCat = String(rows[0]?.category ?? "").trim();
  } catch {
    /* completed_orders category is best-effort */
  }

  const cats = Array.from(new Set([ledgerCat, eventsCat, ordersCat].filter(Boolean)));
  const eventCategory = ledgerCat || eventsCat || ordersCat;
  dbg(`event ${eventId}: ledgerCat=${JSON.stringify(ledgerCat)} eventsCat=${JSON.stringify(eventsCat)} ordersCat=${JSON.stringify(ordersCat)} band=${band} (avgPrice ${avgTicketPrice})`);

  const empty: ClusterBaseline = {
    matched: false, strategy: null, event_category: eventCategory, price_band: band,
    cluster_category: null, cpa_p50: null, ctr_p50: null, roas_p50: null, sample_size: null,
  };
  if (!cats.length) {
    dbg("no category resolved → empty");
    return empty;
  }

  // Fetch the whole (small) baseline table once; match in memory.
  const { data } = await sb
    .from("dca_cluster_baselines")
    .select("event_category,price_band,cpa_p50,ctr_p50,roas_p50,sample_size");
  const rows = (data ?? []) as ClusterRow[];
  if (!rows.length) return empty;

  const lcCats = cats.map((c) => c.trim().toLowerCase());
  const tokens = Array.from(new Set(cats.flatMap(categoryTokens)));
  dbg(`tokens: [${tokens.join(", ")}]`);

  const exactIn = (b: string) =>
    rows.filter((r) => r.price_band === b && lcCats.includes(r.event_category.trim().toLowerCase()));
  const tokenIn = (b: string) =>
    rows.filter((r) => r.price_band === b && tokens.some((t) => r.event_category.toLowerCase().includes(t)));
  const maxSample = (rs: ClusterRow[]) =>
    rs.length ? rs.reduce((a, c) => ((c.sample_size ?? 0) > (a.sample_size ?? 0) ? c : a)) : null;

  const rungs: [string, () => ClusterRow[]][] = [
    ["exact", () => exactIn(band)],
    ["contains", () => tokenIn(band)],
    ["adjacent-band", () => ADJACENT_BANDS[band].flatMap((b) => [...exactIn(b), ...tokenIn(b)])],
    ["category-any-band", () => [...tokenIn("low"), ...tokenIn("mid"), ...tokenIn("high")]],
  ];

  for (const [label, fn] of rungs) {
    const cands = fn();
    dbg(`rung "${label}": ${cands.length} candidate(s)`, cands.map((c) => `${c.event_category}/${c.price_band}(n=${c.sample_size})`).join(" | "));
    const m = maxSample(cands);
    if (m) {
      dbg(`PICK ${m.event_category}/${m.price_band} n=${m.sample_size} via "${label}"`);
      return {
        matched: true, strategy: label, event_category: eventCategory, price_band: band,
        cluster_category: m.event_category, cpa_p50: m.cpa_p50, ctr_p50: m.ctr_p50,
        roas_p50: m.roas_p50, sample_size: m.sample_size,
      };
    }
  }
  dbg("no match across all rungs → empty");
  return empty;
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

/**
 * A sibling's top-performing segments over the last 14 days (Fix 3A).
 * Meta: group dca_v_meta_ads by (campaign, ad_name), ROAS = purchase_value_aed /
 * spend_aed, keep spend > 100 AED, top by ROAS. Google: group dca_v_google_ads
 * by (campaign, ad_group), no revenue → rank by conversions. Event linkage is
 * the campaign-name convention `_<eventId>_` (Meta) / contains <eventId> (Google).
 */
async function getWinningSegments(
  siblingId: number,
  dateTo: string,
  metaMax = 3,
  googleMax = 2,
): Promise<WinningSegment[]> {
  const sb = getSupabase();
  const from = isoDate(addDays(new Date(dateTo + "T00:00:00"), -14));
  const out: WinningSegment[] = [];

  // --- Meta (real ROAS) ---
  try {
    const { data } = await sb
      .from("dca_v_meta_ads")
      .select("campaign,ad_name,spend_aed,purchase_value_aed,purchases,clicks,impressions")
      .ilike("campaign", `*_${siblingId}_*`)
      .gte("date", from)
      .lte("date", dateTo)
      .limit(2000);
    type Agg = { spend: number; rev: number; purch: number; clicks: number; impr: number; campaign: string; ad_name: string };
    const groups = new Map<string, Agg>();
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const campaign = String(r.campaign ?? "");
      const ad_name = String(r.ad_name ?? "");
      const k = campaign + "||" + ad_name;
      const g = groups.get(k) ?? { spend: 0, rev: 0, purch: 0, clicks: 0, impr: 0, campaign, ad_name };
      g.spend += Number(r.spend_aed ?? 0);
      g.rev += Number(r.purchase_value_aed ?? 0);
      g.purch += Number(r.purchases ?? 0);
      g.clicks += Number(r.clicks ?? 0);
      g.impr += Number(r.impressions ?? 0);
      groups.set(k, g);
    }
    const meta = Array.from(groups.values())
      .filter((g) => g.spend > 100)
      .map((g) => ({
        source: "meta" as const,
        ad_name: g.ad_name || null,
        campaign: g.campaign || null,
        roas: g.spend > 0 ? g.rev / g.spend : null,
        spend_aed: g.spend,
        conversions: g.purch,
        ctr: g.impr > 0 ? g.clicks / g.impr : null,
      }))
      .sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0))
      .slice(0, metaMax);
    out.push(...meta);
  } catch {
    /* meta segments best-effort */
  }

  // --- Google (no revenue → rank by conversions) ---
  try {
    const { data } = await sb
      .from("dca_v_google_ads")
      .select("campaign,ad_group,spend_aed,conversions,clicks,impressions")
      .ilike("campaign", `*${siblingId}*`)
      .gte("date", from)
      .lte("date", dateTo)
      .limit(2000);
    type Agg = { spend: number; conv: number; clicks: number; impr: number; campaign: string; ad_group: string };
    const groups = new Map<string, Agg>();
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const campaign = String(r.campaign ?? "");
      const ad_group = String(r.ad_group ?? "");
      const k = campaign + "||" + ad_group;
      const g = groups.get(k) ?? { spend: 0, conv: 0, clicks: 0, impr: 0, campaign, ad_group };
      g.spend += Number(r.spend_aed ?? 0);
      g.conv += Number(r.conversions ?? 0);
      g.clicks += Number(r.clicks ?? 0);
      g.impr += Number(r.impressions ?? 0);
      groups.set(k, g);
    }
    const google = Array.from(groups.values())
      .filter((g) => g.spend > 100 && g.conv > 0)
      .map((g) => ({
        source: "google" as const,
        ad_name: g.ad_group || null,
        campaign: g.campaign || null,
        roas: null,
        spend_aed: g.spend,
        conversions: g.conv,
        ctr: g.impr > 0 ? g.clicks / g.impr : null,
      }))
      .sort((a, b) => (b.conversions ?? 0) - (a.conversions ?? 0))
      .slice(0, googleMax);
    out.push(...google);
  } catch {
    /* google segments best-effort */
  }

  return out;
}

/**
 * Fix 4 + Fix 3: the CURRENT event's own ad-set/ad-group granularity.
 * Meta: REAL audience-typed ad-set names from channels_3_campaign_level_llm.ad_group
 * (e.g. "LALs-X-Arabic", "Remarketing", "DBs") — same source as the Marketing
 * Insights dashboard. (We previously used dca_v_meta_ads.ad_name, which is the
 * creative-variant code — wrong grain.) Google: dca_v_google_ads campaign×ad_group
 * (channels_3 google ad_group is "-"). spend >= 25 AED drops noise. Lets the AI
 * cite "kill ad set X / scale ad set Y" with real names + numbers (within-event).
 */
export async function getOwnSegments(
  eventId: number,
  dateFrom: string,
  dateTo: string,
): Promise<OwnSegments> {
  const sb = getSupabase();
  const result: OwnSegments = { meta: { top: [], bottom: [] }, google: { top: [], bottom: [] } };

  // --- Meta: real ad-set names from channels_3.ad_group (fb & instagram rows) ---
  try {
    const rows = await bq.query<Record<string, unknown>>(
      `SELECT ad_group,
              SUM(spend_aed) AS spend, SUM(impressions) AS impr, SUM(clicks) AS clicks,
              SUM(total_quantity) AS tix, SUM(total_revenue_aed) AS rev
       FROM \`${BQ_PROJECT}.${BQ_DATASET}.channels_3_campaign_level_llm\`
       WHERE event_id = @eid AND date BETWEEN @from AND @to
         AND REGEXP_CONTAINS(LOWER(source), r'fb|facebook|instagram|meta')
         AND ad_group IS NOT NULL AND ad_group != '-'
       GROUP BY ad_group`,
      { eid: String(eventId), from: dateFrom, to: dateTo },
    );
    const ads: AdSet[] = rows
      .map((r) => {
        const spend = Number(r.spend ?? 0), impr = Number(r.impr ?? 0), clicks = Number(r.clicks ?? 0);
        const tix = Number(r.tix ?? 0), rev = Number(r.rev ?? 0);
        return {
          source: "meta" as const,
          name: String(r.ad_group),
          campaign: null, // audience IS the ad-set name now
          spend_aed: spend,
          ctr: impr > 0 ? clicks / impr : null,
          conversions: tix,
          roas: spend > 0 ? rev / spend : null,
          cpa: tix > 0 ? spend / tix : null,
          frequency: null, // not available at channels_3 grain
          conversion_rate: null,
        };
      })
      .filter((a) => a.spend_aed >= 25);
    result.meta.top = [...ads].sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0)).slice(0, 5);
    result.meta.bottom = ads
      .filter((a) => (a.conversions ?? 0) > 0 && a.cpa != null)
      .sort((a, b) => (b.cpa ?? 0) - (a.cpa ?? 0))
      .slice(0, 3);
  } catch {
    /* meta own-segments best-effort */
  }

  // --- Google: group by (campaign, ad_group); no revenue → rank by conversions ---
  try {
    const { data } = await sb
      .from("dca_v_google_ads")
      .select("campaign,ad_group,spend_aed,impressions,clicks,conversions,conversion_rate")
      .ilike("campaign", `*${eventId}*`)
      .gte("date", dateFrom)
      .lte("date", dateTo)
      .limit(3000);
    type G = { spend: number; impr: number; clicks: number; conv: number; campaign: string; ad_group: string };
    const g = new Map<string, G>();
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const campaign = String(r.campaign ?? "");
      const ad_group = String(r.ad_group ?? "");
      const k = campaign + "||" + ad_group;
      const m = g.get(k) ?? { spend: 0, impr: 0, clicks: 0, conv: 0, campaign, ad_group };
      m.spend += Number(r.spend_aed ?? 0);
      m.impr += Number(r.impressions ?? 0);
      m.clicks += Number(r.clicks ?? 0);
      m.conv += Number(r.conversions ?? 0);
      g.set(k, m);
    }
    const shortGroup = (ag: string) => ag.replace(/^customers\/\d+\/adGroups\//, ""); // raw ad_group is a resource path
    const rows: AdSet[] = Array.from(g.values())
      .filter((m) => m.spend >= 25)
      .map((m) => ({
        source: "google" as const,
        name: `${m.campaign} › ${shortGroup(m.ad_group)}`,
        campaign: m.campaign || null,
        spend_aed: m.spend,
        ctr: m.impr > 0 ? m.clicks / m.impr : null,
        conversions: m.conv,
        roas: null,
        cpa: m.conv > 0 ? m.spend / m.conv : null, // cost per conversion
        frequency: null,
        conversion_rate: m.clicks > 0 ? m.conv / m.clicks : null,
      }));
    result.google.top = [...rows].sort((a, b) => (b.conversions ?? 0) - (a.conversions ?? 0)).slice(0, 5);
    result.google.bottom = rows
      .filter((r) => (r.conversions ?? 0) > 0 && r.cpa != null)
      .sort((a, b) => (b.cpa ?? 0) - (a.cpa ?? 0))
      .slice(0, 3);
  } catch {
    /* google own-segments best-effort */
  }

  return result;
}

/**
 * CLAUDE.md reference-data priority #3: affinity siblings CURRENTLY RUNNING.
 * Top co-purchase neighbours from dca_v_affinity, filtered to ledger
 * status='running', with each one's same-window metrics + winning segments.
 * Empty array when the event has no affinity graph yet (new events) — callers /
 * prompts must say so, never invent (Sacred Rule #11).
 */
export async function getAffinitySiblings(
  eventId: number,
  dateFrom: string,
  dateTo: string,
  limit = 5,
): Promise<AffinitySibling[]> {
  const sb = getSupabase();

  // Pull more than `limit` candidates so the running-only filter still yields up to `limit`.
  const { data: affData } = await sb
    .from("dca_v_affinity")
    .select("id_event_2,affinity_norm")
    .eq("id_event", eventId)
    .order("affinity_norm", { ascending: false })
    .limit(limit * 4);
  const cand = (affData ?? []) as { id_event_2: number; affinity_norm: number }[];
  if (!cand.length) return [];

  // Keep only siblings that are currently running in the ledger; carry their names.
  const candIds = cand.map((c) => String(c.id_event_2));
  const { data: ledData } = await sb
    .from("dca_campaign_ledger")
    .select("event_id,event_name,status")
    .in("event_id", candIds)
    .eq("status", "running");
  const running = new Map(
    ((ledData ?? []) as { event_id: string; event_name: string }[]).map((r) => [
      String(r.event_id),
      r.event_name,
    ]),
  );

  const ordered = cand.filter((c) => running.has(String(c.id_event_2))).slice(0, limit);

  const out: AffinitySibling[] = [];
  for (const c of ordered) {
    const sid = String(c.id_event_2);
    try {
      const [snap, winning_segments] = await Promise.all([
        computeSnapshot(c.id_event_2, dateFrom, dateTo),
        getWinningSegments(c.id_event_2, dateTo),
      ]);
      const meta = snap.channels.find((ch) => ch.source.toLowerCase() === "meta") ?? null;
      const google = snap.channels.find((ch) => ch.source.toLowerCase() === "google") ?? null;
      out.push({
        event_id: sid,
        name: running.get(sid) ?? "",
        affinity_norm: c.affinity_norm,
        sales_aed: snap.kpis.total_sales_aed,
        spend_aed: snap.kpis.total_spend_aed,
        tickets: snap.ads_performance.tickets,
        roas: snap.kpis.total_roas,
        meta_ctr: meta ? meta.ctr : null,
        google_ctr: google ? google.ctr : null,
        winning_segments,
      });
    } catch {
      /* skip siblings that error in the window */
    }
  }
  return out;
}
