/**
 * Red Flag rule engine (P2.1) — PURE, no I/O.
 *
 * Takes a getEventReport() output and returns the Red Flags that fire, per the
 * CLAUDE.md threshold table. Three rules are LIVE now; three need prev-period
 * data (P1.5) and return nothing yet.
 *
 *   LIVE
 *     marketing_share : red if marketing ticket share < 15%
 *     meta_cpa        : red if Meta CPA > AED 150 OR > 10% of ticket price (stricter wins)
 *     google_cpa      : red if Google CPA outside 5–25% of ticket price
 *   TODO (need week-over-week / daily series — P1.5)
 *     cpa_streak      : CPA rising 3 days in a row
 *     roas_wow        : ROAS down WoW (yellow)
 *     ctr_drop        : Meta CTR drop > 20% (7d vs prev 7d)
 */

import type { EventReport } from "@/src/lib/data/events";

export type Severity = "yellow" | "red";

export type RedFlag = {
  rule_key: string;
  value: number; // the metric value that tripped (for storage / display)
  threshold: number; // the threshold it breached
  severity: Severity;
  message: string;
};

const AED = (n: number) => "AED " + Math.round(n).toLocaleString("en-US");

export function detectRedFlags(report: EventReport): RedFlag[] {
  const flags: RedFlag[] = [];
  const price = report.kpis.avg_ticket_price;

  // --- marketing_share: capped marketing tickets ÷ actual tickets sold ---
  const totalTickets = report.kpis.tickets_sold;
  if (totalTickets > 0) {
    const share = report.ads_performance.tickets / totalTickets; // 0..1
    if (share < 0.15) {
      flags.push({
        rule_key: "marketing_share",
        value: +(share * 100).toFixed(1),
        threshold: 15,
        severity: "red",
        message: `Marketing ticket share ${(share * 100).toFixed(1)}% < 15%`,
      });
    }
  }

  // --- meta_cpa: > AED 150 OR > 10% of ticket price (whichever stricter = lower) ---
  const meta = report.channels.find((c) => c.source.toLowerCase() === "meta");
  if (meta && meta.spend > 0 && price > 0) {
    const cpa = meta.tickets > 0 ? meta.spend / meta.tickets : Infinity;
    const thr = Math.min(150, 0.1 * price);
    if (cpa > thr) {
      flags.push({
        rule_key: "meta_cpa",
        value: Number.isFinite(cpa) ? +cpa.toFixed(2) : meta.spend,
        threshold: +thr.toFixed(2),
        severity: "red",
        message: `Meta CPA ${Number.isFinite(cpa) ? AED(cpa) : "∞ (0 conversions)"} > ${AED(thr)} (stricter of AED 150 / 10% price)`,
      });
    }
  }

  // --- google_cpa: outside 5–25% of ticket price ---
  const google = report.channels.find((c) => c.source.toLowerCase() === "google");
  if (google && google.spend > 0 && price > 0) {
    const cpa = google.tickets > 0 ? google.spend / google.tickets : Infinity;
    const lo = 0.05 * price;
    const hi = 0.25 * price;
    if (cpa < lo || cpa > hi) {
      flags.push({
        rule_key: "google_cpa",
        value: Number.isFinite(cpa) ? +cpa.toFixed(2) : google.spend,
        threshold: +hi.toFixed(2),
        severity: "red",
        message: `Google CPA ${Number.isFinite(cpa) ? AED(cpa) : "∞ (0 conversions)"} outside ${AED(lo)}–${AED(hi)} (5–25% price)`,
      });
    }
  }

  // --- TODO (P1.5 prev-period data): cpa_streak, roas_wow, ctr_drop ---
  // Intentionally not evaluated until the data layer exposes daily series + WoW.

  return flags;
}

/** Maps a fired rule_key → which lens dot lights up (for the card UI, B7). */
export function ruleToLens(rule_key: string): "Internal" | "Meta" | "Google" | "GA4" | null {
  if (rule_key === "marketing_share") return "Internal";
  if (rule_key.startsWith("meta") || rule_key === "ctr_drop") return "Meta";
  if (rule_key.startsWith("google")) return "Google";
  return null;
}
