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
/** This event's OWN ad sets for a channel: top performers + worst performers. */
export function ownSegmentsStr(report: EventReport, source: "meta" | "google"): string {
  const seg = report.ownSegments?.[source];
  if (!seg || (seg.top.length === 0 && seg.bottom.length === 0)) {
    return "no own ad-set breakdown available (insufficient spend or no linked campaigns)";
  }
  const fmtMeta = (a: { name: string; roas: number | null; cpa: number | null; spend_aed: number; frequency: number | null }) =>
    `"${a.name}": ROAS ${a.roas === null ? "n/a" : r2(a.roas) + "x"}, CPA ${a.cpa === null ? "n/a" : "AED " + r2(a.cpa)}, spend AED ${r2(a.spend_aed)}, freq ${a.frequency === null ? "n/a" : r2(a.frequency)}`;
  const fmtGoogle = (a: { name: string; conversions: number | null; cpa: number | null; conversion_rate: number | null; spend_aed: number }) =>
    `"${a.name}": ${a.conversions ?? 0} conv, cost/conv ${a.cpa === null ? "n/a" : "AED " + r2(a.cpa)}, convRate ${a.conversion_rate === null ? "n/a" : pctn(a.conversion_rate) + "%"}, spend AED ${r2(a.spend_aed)}`;
  const fmt = source === "meta" ? fmtMeta : fmtGoogle;
  const top = seg.top.map((a, i) => `  ${i + 1}. ${fmt(a)}`).join("\n") || "  (none)";
  const bottom = seg.bottom.map((a, i) => `  ${i + 1}. ${fmt(a)}`).join("\n") || "  (none)";
  return `top by ${source === "meta" ? "ROAS" : "conversions"}:\n${top}\nworst (${source === "meta" ? "highest CPA" : "highest cost/conv"}, spend>50 AED):\n${bottom}`;
}

export function segmentsStr(report: EventReport): string {
  const sibs = report.affinitySiblings ?? [];
  const lines: string[] = [];
  for (const s of sibs) {
    for (const w of s.winning_segments ?? []) {
      const perf =
        w.source === "meta"
          ? `ROAS ${w.roas === null ? "n/a" : r2(w.roas) + "x"}, ${w.conversions ?? 0} purch`
          : `${w.conversions ?? 0} conv`;
      lines.push(
        `${s.name || s.event_id} → [${w.source}] ${w.ad_name ?? "?"} (audience: ${w.campaign ?? "?"}): ${perf}, CTR ${w.ctr === null ? "n/a" : pctn(w.ctr) + "%"}, spend AED ${r2(w.spend_aed)}`,
      );
    }
  }
  return lines.length ? lines.join("\n") : "no clearly-winning sibling segments (or none running)";
}
function siblingsStr(report: EventReport): string {
  if (!report.affinitySiblings?.length) return "none currently running";
  return report.affinitySiblings
    .map((s) => `${s.name || s.event_id} (affinity ${r2(s.affinity_norm)}): ROAS ${r2(s.roas)}x, MetaCTR ${s.meta_ctr === null ? "n/a" : pctn(s.meta_ctr) + "%"}, GoogleCTR ${s.google_ctr === null ? "n/a" : pctn(s.google_ctr) + "%"}, sales AED ${r2(s.sales_aed)}`)
    .join(" | ");
}
/** Serialise Lens 5 past-decision items for the prompt (capped + trimmed). */
function pastDecisionsStr(report: EventReport): string {
  const pd = report.pastDecisions;
  if (!pd || pd.count === 0) return "no prior decisions or notes found for this event (by id or name)";
  return pd.items
    .slice(0, 12)
    .map((i) => `[${i.source}/${i.matched_by}${i.when ? " " + i.when : ""}${i.action ? " action=" + i.action : ""}${i.event_name ? ' "' + i.event_name + '"' : ""}] ${i.text}`)
    .join("\n");
}

const SCHEMA =
  `Return ONLY this JSON: {"lens_score": <0-100 int>, "severity": "green"|"yellow"|"red", ` +
  `"diagnosis_bullets": [<2-3 atomic cited strings>], "cluster_benchmark_used": <string>, ` +
  `"analog_event_cited": <string>, "confidence": "high"|"medium"|"low"}. ` +
  `Scoring: 0-29 green (healthy), 30-60 yellow (contributing factor), 61-100 red (primary cause). ` +
  `Every bullet must cite a number from the data; if you lack data for a point, write "no data for <x>". ` +
  `LEAD the FIRST diagnosis bullet with the strongest benchmark comparison available — cluster baseline, WoW delta, OR an analog/sibling citation — whichever has the most-citable gap, in the form ` +
  `"CTR 3.21% is 47% below the Arabic Events/mid cluster (6.0%, n=111)" or "ROAS 8.3x lags Atif Aslam analog (16.4x) by 50%", NOT "CTR is dropping". ` +
  `If no benchmark data exists at all, say so plainly in the first bullet.`;

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
      "Lens 2 — Meta deep dive. Fatigue / CTR / CPA / ROAS vs prior week, vs cluster baseline, vs analog. " +
      "If affinity siblings are running, note audience-overlap read. If a sibling's WINNING SEGMENT (named ad/audience) outperforms this event's Meta equivalent by >50%, flag it by name as a tactical opportunity to TEST on this campaign (never move budget between events). " +
      "When citing this event's OWN ad sets, ALWAYS use the actual ad_name/campaign string from the data. If a top performer's ROAS exceeds the worst performer's by 3x or more, recommend killing the worst and scaling the best (within-event reallocation, Sacred Rule #9). " +
      "High score = Meta is the primary cause.",
    data: (r) => {
      const m = r.channels.find((c) => c.source === "Meta");
      return {
        meta: m ? { spend: r2(m.spend), ctr_pct: pctn(m.ctr), cpa_aed: r2(m.cpa), roas: r2(m.roas), tickets: r2(m.tickets) } : "no Meta spend",
        meta_ctr_wow: r.deltas?.meta_ctr ? { cur_pct: pctn(r.deltas.meta_ctr.current), prior_pct: pctn(r.deltas.meta_ctr.prior) } : null,
        meta_cpa_wow: r.deltas?.meta_cpa ? { cur_aed: r2(r.deltas.meta_cpa.current), prior_aed: r2(r.deltas.meta_cpa.prior) } : null,
        own_meta_ad_sets: ownSegmentsStr(r, "meta"),
        affinity_siblings_running: siblingsStr(r),
        sibling_winning_segments: segmentsStr(r),
      };
    },
  },
  google: {
    window: "current 7d vs prior 7d",
    rubric:
      "Lens 3 — Google deep dive. CPC / CPA band (5-25% of ticket price) / conversion / wasted spend vs cluster + analog. " +
      "If a sibling's WINNING Google segment (named campaign/ad_group) is converting materially better than this event's, flag it by name as a pattern to TEST here (within-event only, never cross-event budget moves). " +
      "When citing this event's OWN ad groups, ALWAYS use the actual campaign/ad_group string. If a top performer's conversions/efficiency exceeds the worst performer's by 3x or more, recommend killing the worst and scaling the best (within-event, Sacred Rule #9). " +
      "High score = Google is the primary cause.",
    data: (r) => {
      const g = r.channels.find((c) => c.source.toLowerCase() === "google");
      return {
        google: g ? { spend: r2(g.spend), ctr_pct: pctn(g.ctr), cpa_aed: r2(g.cpa), roas: r2(g.roas), tickets: r2(g.tickets) } : "no Google spend",
        ticket_price_aed: r2(r.kpis.avg_ticket_price),
        google_cpa_wow: r.deltas?.google_cpa ? { cur_aed: r2(r.deltas.google_cpa.current), prior_aed: r2(r.deltas.google_cpa.prior) } : null,
        own_google_ad_groups: ownSegmentsStr(r, "google"),
        affinity_siblings_running: siblingsStr(r),
        sibling_winning_segments: segmentsStr(r),
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
      "Lens 5 — Last week review. Read the prior decisions/notes below (unioned from our decisions log, weekly notes, master notes, and the existing dashboard's notes; some matched by event name, not id — say which). " +
      "Assess: did the last intervention's actual outcome move OPPOSITE its prediction (STRONG → high score), or is the same action looping within ~14 days (STRONG)? Flat outcome or 3+ interventions with no upward trend = CONTRIBUTING (mid). Prediction held / no recent touches = HEALTHY (low). " +
      "Cite specific note text. If the list says none were found, score 0 and state plainly that there is no prior-decision history — do NOT invent any.",
    data: (r) => ({ past_decisions: pastDecisionsStr(r) }),
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
  const { data } = await chatJSON<Partial<LensOutput>>({ model: "haiku", system: MASTER_SYSTEM, user, maxTokens: 1000 });
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
      `Only cite factors actually present in the scan.\n\n` +
      `CURRENTLY-RUNNING AFFINITY SIBLINGS (competitive context — same audience, live now): ${siblingsStr(report)}\n\n` +
      `MARKET SCAN:\n${scan.content}\n\n${SCHEMA}`,
    maxTokens: 1000,
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
