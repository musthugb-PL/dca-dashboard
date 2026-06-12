/**
 * 6-lens prompt runner (P2.2). Config-driven for the first build (one module,
 * six configs) rather than six files — same prompts, easier to land + iterate;
 * can be split into lens-prompts/*.ts later. Each lens → structured LensOutput.
 *
 * 5 lenses run on Haiku (chatJSON). Lens 6 (Market) runs Perplexity Sonar for a
 * live scan, then Haiku structures the result (cite-or-stay-quiet).
 */

import type { EventReport } from "@/src/lib/data/events";
import { chatJSON, chatText } from "@/src/lib/openrouter";
import { MASTER_SYSTEM } from "./master-prompt";
import type { LensName, LensOutput, Severity, Confidence } from "./types";

const r2 = (n: number) => Math.round(n * 100) / 100;
const pctn = (n: number) => Math.round(n * 10000) / 100; // ratio → % with 2dp

function clusterStr(report: EventReport): string {
  const c = report.clusterBaseline;
  if (!c || !c.matched) return "none available";
  return `${c.cluster_category}/${c.price_band} (n=${c.sample_size}, ${c.strategy}): CTR p50 ${pctn(c.ctr_p50 ?? 0)}%, CPA p50 AED ${r2(c.cpa_p50 ?? 0)}, ROAS p50 ${r2(c.roas_p50 ?? 0)}x`;
}
function analogStr(report: EventReport): string {
  if (!report.analogs?.length) return "none available";
  return report.analogs
    .map((a) => `${a.name} (#${a.rank}): ROAS ${r2(a.roas)}x, MetaCTR ${a.meta_ctr === null ? "n/a" : pctn(a.meta_ctr) + "%"}, GoogleCTR ${a.google_ctr === null ? "n/a" : pctn(a.google_ctr) + "%"}`)
    .join(" | ");
}

const SCHEMA =
  `Return ONLY this JSON: {"lens_score": <0-100 int>, "severity": "green"|"yellow"|"red", ` +
  `"diagnosis_bullets": [<2-3 atomic cited strings>], "cluster_benchmark_used": <string>, ` +
  `"analog_event_cited": <string>, "confidence": "high"|"medium"|"low"}. ` +
  `Scoring: 0-29 green (healthy), 30-60 yellow (contributing factor), 61-100 red (primary cause). ` +
  `Every bullet must cite a number from the data; if you lack data for a point, write "no data for <x>".`;

type LensCfg = { window: string; rubric: string; data: (r: EventReport) => Record<string, unknown> };

const CONFIG: Record<Exclude<LensName, "market">, LensCfg> = {
  internal: {
    window: "current 7d vs prior 7d",
    rubric:
      "Lens 1 — Internal sales performance. Is the EVENT delivering? Judge sales trajectory vs prior week, marketing ticket share, and whether ads are pulling their weight. High score = event-level demand problem (not the ads).",
    data: (r) => ({
      sales_aed: r2(r.kpis.total_sales_aed),
      prior_sales_aed: r.deltas ? r2(r.deltas.total_sales.prior) : null,
      tickets: r.kpis.tickets_sold,
      prior_tickets: r.deltas ? r.deltas.tickets.prior : null,
      marketing_ticket_share_pct: pctn(r.kpis.tickets_sold ? r.ads_performance.tickets / r.kpis.tickets_sold : 0),
      total_roas: r2(r.kpis.total_roas),
      avg_ticket_price_aed: r2(r.kpis.avg_ticket_price),
    }),
  },
  meta: {
    window: "current 7d vs prior 7d",
    rubric:
      "Lens 2 — Meta deep dive. Fatigue / CTR / CPA / ROAS vs prior week, vs cluster baseline, vs analog. High score = Meta is the primary cause.",
    data: (r) => {
      const m = r.channels.find((c) => c.source === "Meta");
      return {
        meta: m ? { spend: r2(m.spend), ctr_pct: pctn(m.ctr), cpa_aed: r2(m.cpa), roas: r2(m.roas), tickets: r2(m.tickets) } : "no Meta spend",
        meta_ctr_wow: r.deltas?.meta_ctr ? { cur_pct: pctn(r.deltas.meta_ctr.current), prior_pct: pctn(r.deltas.meta_ctr.prior) } : null,
        meta_cpa_wow: r.deltas?.meta_cpa ? { cur_aed: r2(r.deltas.meta_cpa.current), prior_aed: r2(r.deltas.meta_cpa.prior) } : null,
      };
    },
  },
  google: {
    window: "current 7d vs prior 7d",
    rubric:
      "Lens 3 — Google deep dive. CPC / CPA band (5-25% of ticket price) / conversion / wasted spend vs cluster + analog. High score = Google is the primary cause.",
    data: (r) => {
      const g = r.channels.find((c) => c.source.toLowerCase() === "google");
      return {
        google: g ? { spend: r2(g.spend), ctr_pct: pctn(g.ctr), cpa_aed: r2(g.cpa), roas: r2(g.roas), tickets: r2(g.tickets) } : "no Google spend",
        ticket_price_aed: r2(r.kpis.avg_ticket_price),
        google_cpa_wow: r.deltas?.google_cpa ? { cur_aed: r2(r.deltas.google_cpa.current), prior_aed: r2(r.deltas.google_cpa.prior) } : null,
      };
    },
  },
  ga4: {
    window: "current 7d, funnel vs prior-365d benchmark",
    rubric:
      "Lens 4 — GA4 funnel & UX. Did the funnel convert or did the page leak? Compare stage drop-off to the event's own prior-365d benchmark. High score = funnel/LP/checkout problem.",
    data: (r) => ({
      funnel_window: r.funnel.window,
      has_window_data: r.funnel.window.users_on_lp > 0,
      benchmark_prior_365d: r.funnel.benchmark_prior_365d,
    }),
  },
  last_week: {
    window: "last 4 weeks of decisions",
    rubric:
      "Lens 5 — Last week review. Did a prior decision work, or are we looping? NOTE: prior-decision history is not yet wired into this data feed.",
    data: () => ({ prior_decisions: "not available in this feed — cannot assess; state so" }),
  },
};

function coerce(lens: LensName, o: Partial<LensOutput>): LensOutput {
  let score = Math.max(0, Math.min(100, Math.round(Number(o.lens_score ?? 0))));
  const sev: Severity = o.severity ?? (score < 30 ? "green" : score <= 60 ? "yellow" : "red");
  return {
    lens,
    lens_score: score,
    severity: sev,
    diagnosis_bullets: Array.isArray(o.diagnosis_bullets) ? o.diagnosis_bullets.slice(0, 3) : [],
    cluster_benchmark_used: String(o.cluster_benchmark_used ?? "none available"),
    analog_event_cited: String(o.analog_event_cited ?? "none available"),
    confidence: (o.confidence as Confidence) ?? "low",
  };
}

async function runHaikuLens(lens: Exclude<LensName, "market">, report: EventReport, eventName: string): Promise<LensOutput> {
  const cfg = CONFIG[lens];
  const user =
    `${cfg.rubric}\n\nEVENT: ${eventName}\nWINDOW: ${cfg.window}\n` +
    `DATA: ${JSON.stringify(cfg.data(report))}\n` +
    `CLUSTER BASELINE: ${clusterStr(report)}\nANALOGS: ${analogStr(report)}\n\n${SCHEMA}`;
  const { data } = await chatJSON<Partial<LensOutput>>({ model: "haiku", system: MASTER_SYSTEM, user, maxTokens: 700 });
  return coerce(lens, data);
}

async function runMarketLens(report: EventReport, eventName: string): Promise<LensOutput> {
  // 1. Live scan via Sonar.
  const scan = await chatText({
    model: "sonar",
    system: "You are a UAE events market researcher. Be concise and factual; cite sources inline.",
    user: `External factors that could affect ticket demand for "${eventName}" in the UAE during the week ending ${report.event.date ?? "the event window"}: public holidays, Ramadan, weather, salary cycle, competing major events, and any artist-specific news. 4-6 bullet points.`,
    maxTokens: 500,
  });
  // 2. Structure via Haiku.
  const { data } = await chatJSON<Partial<LensOutput>>({
    model: "haiku",
    system: MASTER_SYSTEM,
    user:
      `Lens 6 — Market & external context. Structure the market scan below into the lens JSON. ` +
      `severity: green = no notable external factor, yellow = a contributing factor, red = a dominant external factor explaining the gap. ` +
      `Only cite factors actually present in the scan.\n\nMARKET SCAN:\n${scan.content}\n\n${SCHEMA}`,
    maxTokens: 600,
  });
  return coerce("market", data);
}

export async function runAllLenses(report: EventReport, eventName: string): Promise<LensOutput[]> {
  const [internal, meta, google, ga4, last_week, market] = await Promise.all([
    runHaikuLens("internal", report, eventName),
    runHaikuLens("meta", report, eventName),
    runHaikuLens("google", report, eventName),
    runHaikuLens("ga4", report, eventName),
    runHaikuLens("last_week", report, eventName),
    runMarketLens(report, eventName),
  ]);
  return [internal, meta, google, ga4, last_week, market];
}
