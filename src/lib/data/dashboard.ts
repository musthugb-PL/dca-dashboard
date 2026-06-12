/**
 * Decision-cards data assembly (P2.3-lite).
 *
 * For a given review slot: pull dca_campaign_ledger rows, keep status='running'
 * AND days_since_launch >= 7, then call getEventReport(event_ids[0], today-7, today)
 * for each. No Red Flag / lens logic yet — just the data behind each card.
 */

import { getSupabase } from "@/lib/supabase";
import { getEventReport, type EventReport, type ReportOptions } from "./events";
import { type Slot, isoDate, addDays, daysSince } from "@/src/lib/slot";
import { ruleToLens } from "@/src/lib/red-flags";

export type LensSeverity = "red" | "yellow";
export type CardFlags = {
  total: number;
  red: number;
  yellow: number;
  lens: Partial<Record<"Internal" | "Meta" | "Google" | "GA4", LensSeverity>>;
};

export type LedgerRow = {
  event_id: string;
  event_ids: string[] | null;
  event_name: string;
  country: string | null;
  primary_campaign_manager: string | null;
  status: string | null;
  review_slot: string | null;
  campaign_start_date: string | null;
};

export type ReviewCard = {
  row: LedgerRow;
  primaryEventId: string;
  daysSinceLaunch: number | null;
  report: EventReport | null;
  error: string | null;
  flags: CardFlags;
};

type FlagRow = { event_id: string; rule_key: string; severity: string };

/** Fetch today's (UTC date) red flags for a slot, keyed by event_id. */
async function fetchFlagsForSlot(
  sb: ReturnType<typeof getSupabase>,
  slot: Slot,
  today: Date,
  eventIds: string[],
): Promise<Map<string, FlagRow[]>> {
  const map = new Map<string, FlagRow[]>();
  if (eventIds.length === 0) return map;
  const dayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const { data, error } = await sb
    .from("dca_red_flag_events")
    .select("event_id, rule_key, severity")
    .eq("slot", slot)
    .gte("detected_at", dayStart.toISOString())
    .lt("detected_at", dayEnd.toISOString())
    .in("event_id", eventIds);
  if (error) return map; // flags are best-effort overlay
  for (const r of (data ?? []) as FlagRow[]) {
    const k = String(r.event_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return map;
}

/** Aggregate flags across a card's event_ids → counts + per-lens severity. */
function computeCardFlags(eventIds: string[], flagMap: Map<string, FlagRow[]>): CardFlags {
  const flags: CardFlags = { total: 0, red: 0, yellow: 0, lens: {} };
  for (const id of eventIds) {
    for (const f of flagMap.get(id) ?? []) {
      flags.total++;
      if (f.severity === "red") flags.red++;
      else flags.yellow++;
      const lens = ruleToLens(f.rule_key);
      if (lens && lens !== "GA4") {
        // red wins over yellow on a given lens
        if (f.severity === "red") flags.lens[lens] = "red";
        else if (flags.lens[lens] !== "red") flags.lens[lens] = "yellow";
      }
    }
  }
  return flags;
}

export type ReviewCardsResult = {
  slot: Slot;
  dateFrom: string;
  dateTo: string;
  counts: { totalInSlot: number; running: number; eligible: number };
  cards: ReviewCard[];
};

const ACTIVE_MIN_DAYS = 7;

export async function getReviewCards(
  slot: Slot,
  today: Date,
  reportOpts: ReportOptions = {},
): Promise<ReviewCardsResult> {
  const sb = getSupabase();
  const dateTo = isoDate(today);
  const dateFrom = isoDate(addDays(today, -7));

  const { data, error } = await sb
    .from("dca_campaign_ledger")
    .select(
      "event_id,event_ids,event_name,country,primary_campaign_manager,status,review_slot,campaign_start_date",
    )
    .eq("review_slot", String(slot));
  if (error) throw new Error("dca_campaign_ledger: " + error.message);

  const rows = (data ?? []) as LedgerRow[];
  const running = rows.filter((r) => (r.status ?? "").toLowerCase() === "running");
  const eligible = running.filter((r) => {
    const d = daysSince(r.campaign_start_date, today);
    return d !== null && d >= ACTIVE_MIN_DAYS;
  });

  // All event_ids across eligible rows (festivals contribute their whole array)
  // → fetch today's Red Flags once, attach per card.
  const allIds = Array.from(
    new Set(eligible.flatMap((r) => r.event_ids ?? [r.event_id])),
  );
  const flagMap = await fetchFlagsForSlot(sb, slot, today, allIds);

  const cards: ReviewCard[] = await Promise.all(
    eligible.map(async (row): Promise<ReviewCard> => {
      const primaryEventId = row.event_ids?.[0] ?? row.event_id;
      const daysSinceLaunch = daysSince(row.campaign_start_date, today);
      const flags = computeCardFlags(row.event_ids ?? [primaryEventId], flagMap);
      try {
        const report = await getEventReport(Number(primaryEventId), dateFrom, dateTo, reportOpts);
        return { row, primaryEventId, daysSinceLaunch, report, error: null, flags };
      } catch (e) {
        return {
          row,
          primaryEventId,
          daysSinceLaunch,
          report: null,
          error: e instanceof Error ? e.message : String(e),
          flags,
        };
      }
    }),
  );

  return {
    slot,
    dateFrom,
    dateTo,
    counts: { totalInSlot: rows.length, running: running.length, eligible: eligible.length },
    cards,
  };
}
