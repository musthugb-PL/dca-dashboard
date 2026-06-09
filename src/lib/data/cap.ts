/**
 * Per-event-per-day marketing-attribution cap (CLAUDE.md "Cap logic").
 *
 * Guarantees marketing-attributed tickets never exceed reality. For each day:
 *
 *   raw_marketing_tickets = Σ channel raw_tickets that day
 *   total_tickets         = SUM(tickets_count) from completed_orders that day
 *   cap_ratio             = MIN(1, total_tickets / NULLIF(raw_marketing_tickets, 0))
 *
 * Then every channel that day: capped = raw × cap_ratio.
 *
 * Pure function — no I/O. Raw fields are preserved alongside capped ones so
 * no information is lost (cap is transparent and auditable).
 *
 * NULLIF semantics: if a day has zero marketing tickets there is nothing to
 * scale, so cap_ratio = 1 (the SQL NULL/MIN collapses to "no cap"). If a day
 * had marketing tickets but zero actual sales, cap_ratio = 0 — attribution is
 * correctly zeroed (you can't attribute tickets that were never sold).
 */

export type ChannelDailyRow = {
  date: string; // 'YYYY-MM-DD'
  source: string;
  raw_tickets: number;
  raw_revenue: number;
};

export type SalesDay = {
  date: string;
  total_tickets: number;
};

export type CappedChannelDailyRow = ChannelDailyRow & {
  cap_ratio: number;
  capped_tickets: number;
  capped_revenue: number;
};

export type CapDay = {
  date: string;
  total_tickets: number; // actual, from completed_orders
  raw_marketing_tickets: number; // Σ channels that day
  cap_ratio: number;
  capped: boolean; // true when cap_ratio < 1 (the cap actually bit)
};

export type CapResult = {
  rows: CappedChannelDailyRow[];
  capByDay: CapDay[];
};

export function applyCap(
  channelDailyData: ChannelDailyRow[],
  salesByDay: SalesDay[],
): CapResult {
  // actual tickets sold per day
  const salesMap = new Map<string, number>();
  for (const s of salesByDay) {
    salesMap.set(s.date, (salesMap.get(s.date) ?? 0) + s.total_tickets);
  }

  // raw marketing tickets per day (Σ across channels)
  const rawByDay = new Map<string, number>();
  for (const r of channelDailyData) {
    rawByDay.set(r.date, (rawByDay.get(r.date) ?? 0) + r.raw_tickets);
  }

  // cap_ratio per day
  const allDays = new Set<string>(
    Array.from(rawByDay.keys()).concat(Array.from(salesMap.keys())),
  );
  const capRatioByDay = new Map<string, number>();
  for (const d of Array.from(allDays)) {
    const raw = rawByDay.get(d) ?? 0;
    const total = salesMap.get(d) ?? 0;
    // MIN(1, total / NULLIF(raw, 0)): raw === 0 → nothing to cap → ratio 1
    const ratio = raw === 0 ? 1 : Math.min(1, total / raw);
    capRatioByDay.set(d, ratio);
  }

  const rows: CappedChannelDailyRow[] = channelDailyData.map((r) => {
    const cap_ratio = capRatioByDay.get(r.date) ?? 1;
    return {
      ...r,
      cap_ratio,
      capped_tickets: r.raw_tickets * cap_ratio,
      capped_revenue: r.raw_revenue * cap_ratio,
    };
  });

  const capByDay: CapDay[] = Array.from(capRatioByDay.entries())
    .map(([date, cap_ratio]) => ({
      date,
      total_tickets: salesMap.get(date) ?? 0,
      raw_marketing_tickets: rawByDay.get(date) ?? 0,
      cap_ratio,
      capped: cap_ratio < 1,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { rows, capByDay };
}

/** Convenience: sum capped tickets/revenue per source across all days. */
export function summariseCappedBySource(
  result: CapResult,
): Record<string, { capped_tickets: number; capped_revenue: number }> {
  const out: Record<string, { capped_tickets: number; capped_revenue: number }> =
    {};
  for (const r of result.rows) {
    out[r.source] = out[r.source] ?? { capped_tickets: 0, capped_revenue: 0 };
    out[r.source].capped_tickets += r.capped_tickets;
    out[r.source].capped_revenue += r.capped_revenue;
  }
  return out;
}
