/**
 * Meta attribution — 3-tier primary-label rule (CLAUDE.md "Meta Attribution").
 *
 * Goal: for each Meta campaign linked to an event, infer the campaign's
 * "conversion goal" CC label, count its firings, then scale firings to
 * tickets/revenue using the event's avg_tickets_per_order / avg_ticket_price
 * (from completed_orders via getEventSales).
 *
 * Source-of-truth (CLAUDE.md): Meta tickets + revenue come from CC firings
 * here — NOT from channels_3.total_quantity. Spend still comes from BQ.
 *
 * Reads ONLY `dca_v_*` views (never original tables):
 *   - dca_v_meta_custom_conversions : per campaign × label firing counts
 *   - dca_v_meta_ads                : pixel `purchases` (Tier 3 fallback)
 *   - dca_v_event_campaign_overrides: admin manual campaign↔event attachments
 *
 * Tier 1 — event-id match in label (boundary-checked) → preferred.
 * Tier 2 — token-subset match (every label token ∈ campaign tokens) → legacy.
 * Tier 3 — Meta-pixel `purchases` for the campaign → last fallback.
 */

import { getSupabase } from "@/lib/supabase";
import { getEventSales } from "./bq-event";

// ---------------------------------------------------------------------------
// Tokenisation (Tier 2)
// ---------------------------------------------------------------------------

/**
 * Stopwords for token-subset matching. Base list per T2 spec, PLUS
 * `custom`/`conversions` — every real CC label carries the "Custom
 * Conversions" suffix (verified in dca_v_meta_custom_conversions), which
 * never appears in campaign names, so without these the subset test would
 * always fail. Documented deviation, sanctioned by the spec's "adjust if you
 * find others" note.
 */
const STOPWORDS = new Set([
  "uae", "ksa", "qa", "bh", "om", "egy", "cc", "ad", "sa", "ae",
  "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  "jan", "feb", "mar", "apr", "may",
  "live", "at", "in", "the", "presents",
  // added — see docstring
  "custom", "conversions",
]);

/** lowercase → split on non-alphanumeric → drop stopwords + pure-digit tokens. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** All `_(\d{4,7})_` ids embedded in a campaign name. */
function extractEventIds(campaign: string): string[] {
  const ids: string[] = [];
  const re = /_(\d{4,7})_/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(campaign)) !== null) ids.push(m[1]);
  return ids;
}

/** Boundary-checked standalone-number presence: (^|[^0-9])<id>([^0-9]|$). */
function labelContainsEventId(label: string, eventId: string): boolean {
  const re = new RegExp(`(^|[^0-9])${eventId}([^0-9]|$)`);
  return re.test(label);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetaTier = 1 | 2 | 3;

export type MetaCampaignAttribution = {
  campaign: string;
  matched_via: "auto" | "override";
  primary_label: string; // '__pixel_purchases__' for Tier 3
  tier_used: MetaTier;
  cc_firings: number; // for Tier 3 this is pixel purchases
  meta_tickets: number; // cc_firings × avg_tickets_per_order (raw, pre-cap)
  meta_revenue: number; // meta_tickets × avg_ticket_price   (raw, pre-cap)
};

export type MetaAttribution = {
  event_id: number;
  avg_tickets_per_order: number;
  avg_ticket_price: number;
  campaigns: MetaCampaignAttribution[];
  total_meta_tickets: number;
  total_meta_revenue: number;
};

// ---------------------------------------------------------------------------
// Internal aggregation helpers
// ---------------------------------------------------------------------------

type LabelFirings = Map<string, number>; // label -> total firings
type CcByCampaign = Map<string, LabelFirings>;

function addCcRow(map: CcByCampaign, campaign: string, label: string, n: number) {
  if (!map.has(campaign)) map.set(campaign, new Map());
  const lf = map.get(campaign)!;
  lf.set(label, (lf.get(label) ?? 0) + n);
}

/** Pick the label with the most firings from a set of qualifying labels. */
function pickMostFiring(
  labelFirings: LabelFirings,
  qualifies: (label: string) => boolean,
): { label: string; firings: number } | null {
  let best: { label: string; firings: number } | null = null;
  for (const [label, firings] of Array.from(labelFirings)) {
    if (!qualifies(label)) continue;
    if (!best || firings > best.firings) best = { label, firings };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function getMetaAttribution(
  eventId: number,
  dateFrom: string,
  dateTo: string,
): Promise<MetaAttribution> {
  const sb = getSupabase();
  const eventIdStr = String(eventId);

  // --- avg tickets/order + avg ticket price (the scaling factors) ---
  const sales = await getEventSales(eventId, dateFrom, dateTo);
  const aTPO = sales.avg_tickets_per_order;
  const aTP = sales.avg_ticket_price;

  // --- 1. CC rows for auto-candidate campaigns (name contains the id) ---
  const ccByCampaign: CcByCampaign = new Map();
  const { data: ccAuto, error: ccErr } = await sb
    .from("dca_v_meta_custom_conversions")
    .select("campaign, custom_conversion_label, custom_conversions, date")
    .ilike("campaign", `%${eventIdStr}%`)
    .gte("date", dateFrom)
    .lte("date", dateTo);
  if (ccErr) throw new Error("dca_v_meta_custom_conversions: " + ccErr.message);
  for (const r of ccAuto ?? []) {
    addCcRow(
      ccByCampaign,
      String(r.campaign),
      String(r.custom_conversion_label ?? ""),
      Number(r.custom_conversions ?? 0),
    );
  }

  // --- 2. Pixel purchases (Tier 3) for auto-candidate campaigns ---
  const pixelByCampaign = new Map<string, number>();
  const { data: adsAuto, error: adsErr } = await sb
    .from("dca_v_meta_ads")
    .select("campaign, purchases, date")
    .ilike("campaign", `%${eventIdStr}%`)
    .gte("date", dateFrom)
    .lte("date", dateTo);
  if (adsErr) throw new Error("dca_v_meta_ads: " + adsErr.message);
  for (const r of adsAuto ?? []) {
    const c = String(r.campaign);
    pixelByCampaign.set(c, (pixelByCampaign.get(c) ?? 0) + Number(r.purchases ?? 0));
  }

  // --- 3. Manual overrides (platform = 'meta' OR NULL) ---
  const { data: overrides, error: ovErr } = await sb
    .from("dca_v_event_campaign_overrides")
    .select("campaign_name, platform")
    .eq("event_id", eventIdStr)
    .or("platform.eq.meta,platform.is.null");
  if (ovErr) throw new Error("dca_v_event_campaign_overrides: " + ovErr.message);
  const overrideNames = new Set(
    (overrides ?? []).map((r) => String(r.campaign_name)),
  );

  // --- 4. Auto-linked campaigns: regex extracts this event id ---
  const autoCampaigns = new Set<string>();
  const candidateCampaigns = new Set<string>(
    Array.from(ccByCampaign.keys()).concat(Array.from(pixelByCampaign.keys())),
  );
  for (const c of Array.from(candidateCampaigns)) {
    if (extractEventIds(c).includes(eventIdStr)) autoCampaigns.add(c);
  }

  // --- 5. Override campaigns may not contain the id in name → fetch theirs ---
  const missingOverrides = Array.from(overrideNames).filter(
    (c) => !ccByCampaign.has(c) && !pixelByCampaign.has(c),
  );
  if (missingOverrides.length > 0) {
    const { data: ccOv } = await sb
      .from("dca_v_meta_custom_conversions")
      .select("campaign, custom_conversion_label, custom_conversions, date")
      .in("campaign", missingOverrides)
      .gte("date", dateFrom)
      .lte("date", dateTo);
    for (const r of ccOv ?? []) {
      addCcRow(
        ccByCampaign,
        String(r.campaign),
        String(r.custom_conversion_label ?? ""),
        Number(r.custom_conversions ?? 0),
      );
    }
    const { data: adsOv } = await sb
      .from("dca_v_meta_ads")
      .select("campaign, purchases, date")
      .in("campaign", missingOverrides)
      .gte("date", dateFrom)
      .lte("date", dateTo);
    for (const r of adsOv ?? []) {
      const c = String(r.campaign);
      pixelByCampaign.set(c, (pixelByCampaign.get(c) ?? 0) + Number(r.purchases ?? 0));
    }
  }

  // --- 6. Resolve a primary label per campaign via the 3-tier fallback ---
  const campaignSet = new Set<string>(
    Array.from(autoCampaigns).concat(Array.from(overrideNames)),
  );
  const campaigns: MetaCampaignAttribution[] = [];

  for (const campaign of Array.from(campaignSet)) {
    const matched_via: "auto" | "override" = overrideNames.has(campaign)
      ? "override"
      : "auto";
    const labelFirings = ccByCampaign.get(campaign) ?? new Map<string, number>();
    const campaignTokens = new Set(tokenize(campaign));

    let tier_used: MetaTier;
    let primary_label: string;
    let cc_firings: number;

    // Tier 1 — event-id present in label (boundary-checked)
    const t1 = pickMostFiring(labelFirings, (label) =>
      labelContainsEventId(label, eventIdStr),
    );
    // Tier 2 — every label token ⊆ campaign tokens
    const t2 =
      t1 === null
        ? pickMostFiring(labelFirings, (label) => {
            const labelTokens = tokenize(label);
            return (
              labelTokens.length > 0 &&
              labelTokens.every((t) => campaignTokens.has(t))
            );
          })
        : null;

    if (t1) {
      tier_used = 1;
      primary_label = t1.label;
      cc_firings = t1.firings;
    } else if (t2) {
      tier_used = 2;
      primary_label = t2.label;
      cc_firings = t2.firings;
    } else {
      // Tier 3 — Meta-pixel purchases (purchase ≈ order, scaled like firings)
      tier_used = 3;
      primary_label = "__pixel_purchases__";
      cc_firings = pixelByCampaign.get(campaign) ?? 0;
    }

    const meta_tickets = cc_firings * aTPO;
    const meta_revenue = meta_tickets * aTP;

    campaigns.push({
      campaign,
      matched_via,
      primary_label,
      tier_used,
      cc_firings,
      meta_tickets,
      meta_revenue,
    });
  }

  // Stable, useful ordering: biggest contributors first
  campaigns.sort((a, b) => b.meta_tickets - a.meta_tickets);

  return {
    event_id: eventId,
    avg_tickets_per_order: aTPO,
    avg_ticket_price: aTP,
    campaigns,
    total_meta_tickets: campaigns.reduce((s, c) => s + c.meta_tickets, 0),
    total_meta_revenue: campaigns.reduce((s, c) => s + c.meta_revenue, 0),
  };
}
