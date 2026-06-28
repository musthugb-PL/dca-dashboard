import Link from "next/link";
import { getEventReport, type EventReport } from "@/src/lib/data/events";
import { getSupabase } from "@/lib/supabase";
import { reviewWindow, daysSince } from "@/src/lib/slot";
import { aed, intFmt, roasFmt, pctFmt } from "@/src/lib/format";
import { getLatestBrainAnalysis } from "@/src/lib/ai-brain/persist";
import type { BrainAnalysis, LensName, LensOutput } from "@/src/lib/ai-brain/types";
import { getPastDecisionsContext, getAnalogDecisions } from "@/src/lib/data/lens5";
import type { PastDecisions, PastDecisionItem, AnalogEvent, AffinitySibling } from "@/src/lib/data/events";
import DeltaPill from "@/app/components/DeltaPill";
import DecisionFlow from "@/app/components/DecisionFlow";

export const dynamic = "force-dynamic";

type Cmp = { ratio: number; cls: "good" | "mid" | "bad" };
type Wow = { pct: number; goodUp: boolean };
type Tile = { label: string; value: string; wow?: Wow; cluster?: Cmp };

/** value vs cluster p50 → ratio + colour band (±15% = caution). */
function clusterCmp(
  cur: number | null | undefined,
  base: number | null | undefined,
  higherIsBetter: boolean,
): Cmp | undefined {
  if (cur == null || !base) return undefined;
  const ratio = cur / base;
  const cls: Cmp["cls"] = higherIsBetter
    ? ratio >= 1.15 ? "good" : ratio <= 0.85 ? "bad" : "mid"
    : ratio <= 0.85 ? "good" : ratio >= 1.15 ? "bad" : "mid";
  return { ratio, cls };
}
function wowCmp(d: { pct: number } | null | undefined, goodUp: boolean): Wow | undefined {
  return d ? { pct: d.pct, goodUp } : undefined;
}

export default async function EventReportPage({ params }: { params: { eventId: string } }) {
  const today = new Date();
  const { dateFrom, dateTo } = reviewWindow(today); // last 7 full days ending yesterday

  let report: EventReport | null = null;
  let error: string | null = null;
  try {
    report = await getEventReport(Number(params.eventId), dateFrom, dateTo, {
      includePrior: true,
      includeCluster: true,
      includeAnalogs: true,
      includeAffinitySiblings: true, // Fix H — "Similar event patterns" section
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Persisted AI-brain analysis (latest for this event, any slot). Read-only;
  // the brain is run out-of-band (smoke script / slot run), not on page load.
  let analysis: BrainAnalysis | null = null;
  try {
    analysis = await getLatestBrainAnalysis(params.eventId);
  } catch {
    /* analysis overlay is best-effort — page still renders the data layer */
  }

  // Ledger row (manager / start date / festival ids) — header context.
  let manager: string | null = null;
  let eventIds: string[] = [params.eventId];
  let daysRunning: number | null = null;
  let slot: number | null = null;
  try {
    const sb = getSupabase();
    const { data } = await sb
      .from("dca_campaign_ledger")
      .select("primary_campaign_manager,event_ids,campaign_start_date,review_slot")
      .eq("event_id", params.eventId)
      .maybeSingle();
    if (data) {
      manager = data.primary_campaign_manager ?? null;
      eventIds = data.event_ids ?? [params.eventId];
      daysRunning = daysSince(data.campaign_start_date, today);
      slot = data.review_slot != null ? Number(data.review_slot) : null;
    }
  } catch {
    /* ledger lookup is best-effort for the header */
  }
  const isFestival = eventIds.length > 1;

  if (error || !report) {
    return (
      <main className="pl-app">
        <div className="dca-page">
          <Link href="/dashboard" className="pl-btn pl-btn-ghost pl-btn-s dca-back">
            ← Back to Optimization PLUS
          </Link>
          <div className="pl-card pl-card-elevated pl-card-padded dca-empty">
            <p className="t-body-base">Report unavailable for event {params.eventId}.</p>
            {error && <p className="t-caption">{error}</p>}
          </div>
        </div>
      </main>
    );
  }

  const meta = report.channels.find((c) => c.source.toLowerCase() === "meta");
  const google = report.channels.find((c) => c.source.toLowerCase() === "google");
  const f = report.funnel.window;

  // Past decisions for THIS event — exact event_id only (Fix G).
  let pastDecisions: PastDecisions = { items: [], count: 0 };
  try {
    pastDecisions = await getPastDecisionsContext(Number(params.eventId), report.event.name || "");
  } catch {
    /* decision history is best-effort */
  }

  // Fix H: analogs' own past decisions for the "Similar event patterns" section.
  let analogDecisions: Record<string, PastDecisionItem[]> = {};
  try {
    const analogIds = (report.analogs ?? []).slice(0, 3).map((a) => a.event_id);
    if (analogIds.length) analogDecisions = await getAnalogDecisions(analogIds);
  } catch {
    /* analog context is best-effort */
  }

  const cb = report.clusterBaseline;
  const d = report.deltas;

  // Fix F: the Internal lens is last-3-full-days vs prior-3, NOT the 7d window.
  const dailyAsc = [...report.sales.daily].sort((a, b) => (a.date < b.date ? -1 : 1));
  const sum3 = (arr: typeof dailyAsc, k: "rev" | "tickets") => arr.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  const last3Sales = sum3(dailyAsc.slice(-3), "rev");
  const prior3Sales = sum3(dailyAsc.slice(-6, -3), "rev");
  const last3Tickets = sum3(dailyAsc.slice(-3), "tickets");
  const prior3Tickets = sum3(dailyAsc.slice(-6, -3), "tickets");
  const pctPair = (cur: number, prev: number): Wow | undefined => (prev > 0 ? { pct: (cur - prev) / prev, goodUp: true } : undefined);

  // ---- per-lens tile sets (real metrics + WoW + cluster comparison) ----
  // Internal tiles are 3d-vs-prior-3d (Fix F); overall ROAS stays a 7d figure.
  const internalTiles: Tile[] = [
    { label: "Sales (3d)", value: aed(last3Sales), wow: pctPair(last3Sales, prior3Sales) },
    { label: "Tickets (3d)", value: intFmt(last3Tickets), wow: pctPair(last3Tickets, prior3Tickets) },
    { label: "ROAS (total, 7d)", value: roasFmt(report.kpis.total_roas), wow: wowCmp(d?.total_roas, true) },
    { label: "Sales (7d)", value: aed(report.kpis.total_sales_aed) },
    { label: "Avg price", value: aed(report.kpis.avg_ticket_price) },
  ];
  const metaTiles: Tile[] = meta
    ? [
        { label: "Spend", value: aed(meta.spend) },
        { label: "Tickets", value: intFmt(meta.tickets) },
        { label: "Revenue", value: aed(meta.revenue) },
        { label: "CPA", value: aed(meta.cpa), wow: wowCmp(d?.meta_cpa, false), cluster: clusterCmp(meta.cpa, cb?.cpa_p50, false) },
        { label: "ROAS", value: roasFmt(meta.roas), cluster: clusterCmp(meta.roas, cb?.roas_p50, true) },
        { label: "CTR", value: pctFmt(meta.ctr), wow: wowCmp(d?.meta_ctr, true), cluster: clusterCmp(meta.ctr, cb?.ctr_p50, true) },
      ]
    : [{ label: "Meta", value: "no spend in window" }];
  const googleTiles: Tile[] = google
    ? [
        { label: "Spend", value: aed(google.spend) },
        { label: "Tickets", value: intFmt(google.tickets) },
        { label: "Revenue", value: aed(google.revenue) },
        { label: "CPA", value: aed(google.cpa), wow: wowCmp(d?.google_cpa, false), cluster: clusterCmp(google.cpa, cb?.cpa_p50, false) },
        { label: "ROAS", value: roasFmt(google.roas), cluster: clusterCmp(google.roas, cb?.roas_p50, true) },
        { label: "CTR", value: pctFmt(google.ctr), cluster: clusterCmp(google.ctr, cb?.ctr_p50, true) },
      ]
    : [{ label: "Google", value: "no spend in window" }];
  const ga4Tiles: Tile[] = [
    { label: "LP users", value: intFmt(f.users_on_lp) },
    { label: "Add to cart", value: intFmt(f.users_add_to_cart) },
    { label: "Checkout", value: intFmt(f.users_with_checkout) },
    { label: "Purchase", value: intFmt(f.users_with_purchase) },
  ];
  const narrativeTiles: Tile[] = [{ label: "Source", value: "Overall market read below" }];

  // Lens key → persisted lens output (if the brain has been run for this event).
  const lensByKey = new Map<LensName, LensOutput>(
    (analysis?.lenses ?? []).map((l) => [l.lens, l]),
  );

  // ---- Fix 11: per-lens hero metric (+ sparkline series for Internal) ----
  const internalHero: Hero = {
    label: "Sales · last 3 days",
    value: aed(last3Sales),
    pill: pctPair(last3Sales, prior3Sales),
    series: dailyAsc.map((x) => x.rev),
  };
  const metaHero: Hero | undefined = meta
    ? { label: "Meta · CPA", value: aed(meta.cpa), pill: wowCmp(d?.meta_cpa, false) }
    : { label: "Meta", value: "no spend in window" };
  const googleHero: Hero | undefined = google
    ? { label: "Google · cost/conv", value: aed(google.cpa), pill: wowCmp(d?.google_cpa, false) }
    : { label: "Google", value: "no spend in window" };
  const ga4Hero: Hero = { label: "Funnel · purchases (7d)", value: intFmt(f.users_with_purchase) };

  const LENSES: LensDef[] = [
    { name: "Internal", key: "internal", window: "3d vs prior 3d", tiles: internalTiles, hero: internalHero },
    { name: "Meta", key: "meta", window: "7d vs T-7", tiles: metaTiles, hero: metaHero },
    { name: "Google", key: "google", window: "7d vs T-7", tiles: googleTiles, hero: googleHero },
    { name: "GA4", key: "ga4", window: "7d vs T-7", tiles: ga4Tiles, hero: ga4Hero },
    { name: "Last week", key: "last_week", window: "last 4 weeks", tiles: narrativeTiles },
    { name: "Market", key: "market", window: "past 7d + next 14d", tiles: narrativeTiles },
  ];

  return (
    <main className="pl-app">
      <div className="dca-page">
        <Link href="/dashboard" className="pl-btn pl-btn-ghost pl-btn-s dca-back">
          ← Back to Optimization PLUS
        </Link>

        {/* a. Header */}
        <div className="dca-card-head">
          <h1 className="t-title-xl">{report.event.name || `Event ${params.eventId}`}</h1>
          {isFestival && <span className="dca-chip dca-chip--count">{eventIds.length} events</span>}
          <StatusPill status={report.event.status} />
        </div>
        <div className="dca-subtitle t-caption">
          <span className="dca-chip dca-id-chip">Event {params.eventId}</span>
          {report.event.country && <span>{report.event.country}</span>}
          {report.event.venue && (
            <>
              <span className="dca-dot-sep">·</span>
              <span>{report.event.venue}</span>
            </>
          )}
          {manager && (
            <>
              <span className="dca-dot-sep">·</span>
              <span>{manager}</span>
            </>
          )}
          <span className="dca-dot-sep">·</span>
          <span>{daysRunning !== null ? `${daysRunning} days running` : "launch date n/a"}</span>
          <span className="dca-dot-sep">·</span>
          <span>window {dateFrom} → {dateTo}</span>
        </div>

        {/* B2 sticky header + B4 verdict wrap the KPI strip, timeline, and lenses */}
        <DecisionFlow
          verdict={analysis?.verdict ?? null}
          eventId={params.eventId}
          slot={slot}
          headerMeta={{
            eventName: report.event.name || `Event ${params.eventId}`,
            country: report.event.country || null,
            manager,
            window: `${dateFrom} → ${dateTo}`,
          }}
        >
          {/* b. KPI strip — with WoW deltas (vs prior 7d) */}
          <section className="pl-card pl-card-elevated pl-card-padded" style={{ marginTop: "var(--spacing-16)" }}>
            {/* Fix D — data provenance badge */}
            <p className="dca-source-badge t-caption">
              Data: BQ channels_3 + Supabase CC · last 7 full days ending yesterday ({dateFrom} → {dateTo}, UTC) · Tier 1/2/3 Meta attribution.
              {" "}The Marketing Insights Dashboard may differ slightly (calendar-week window / UAE timezone) — see bq-event.ts.
            </p>
            <h2 className="t-title-sm">KPIs {report.deltas && <span className="dca-lens-window t-caption">(vs prior 7d)</span>}</h2>
            <div className="dca-report-grid">
              <KpiTile label="Sales" value={aed(report.kpis.total_sales_aed)} d={report.deltas?.total_sales.pct} goodUp />
              <KpiTile label="Spend" value={aed(report.kpis.total_spend_aed)} d={report.deltas?.total_spend.pct} goodUp={false} />
              <KpiTile label="ROAS" value={roasFmt(report.kpis.total_roas)} d={report.deltas?.total_roas.pct} goodUp />
              <KpiTile label="Tickets" value={intFmt(report.kpis.tickets_sold)} d={report.deltas?.tickets.pct} goodUp />
            </div>
          </section>

          {/* b2. Past decisions timeline */}
          <PastDecisionsSection pd={pastDecisions} />

          {/* c. Six lens sections (B1 rebuild) */}
          <div className="dca-lens-sections">
            {LENSES.map((lens) => (
              <LensCard
                key={lens.name}
                lens={lens}
                lo={lensByKey.get(lens.key)}
                hasAnalysis={!!analysis}
                clusterFallback={clusterLine(report)}
                analogFallback={analogLine(report, lens.name)}
              />
            ))}
          </div>

          {/* Fix H — Similar event patterns (cross-event reference, between lenses & verdict) */}
          <SimilarEventPatterns
            analogs={report.analogs ?? []}
            siblings={report.affinitySiblings ?? []}
            analogDecisions={analogDecisions}
          />
        </DecisionFlow>
      </div>
    </main>
  );
}

function StatusPill({ status }: { status: string | null }) {
  const s = (status ?? "").toLowerCase();
  if (s.includes("sale") || s === "running")
    return <span className="pl-status-tag pl-status-tag--success">{status || "running"}</span>;
  if (s === "paused")
    return <span className="pl-status-tag pl-status-tag--caution">Paused</span>;
  return <span className="dca-chip">{status || "Unknown"}</span>;
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="dca-tile">
      <span className="dca-tile-label t-caption">{label}</span>
      <span className="dca-tile-value t-title-sm">{value}</span>
    </div>
  );
}

function KpiTile({ label, value, d, goodUp }: { label: string; value: string; d?: number; goodUp: boolean }) {
  return (
    <div className="dca-tile">
      <span className="dca-tile-label t-caption">{label}</span>
      <span className="dca-tile-value t-title-sm">{value}</span>
      {d !== undefined && (
        <DeltaPill value={d * 100} good={goodUp ? d >= 0 : d <= 0} />
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  decisions: "Decision log",
  weekly_notes: "Weekly note",
  source_b_notes: "Source B",
  optimisation_notes: "Optimisation note",
};

/** Sort key: real dates rank above "Week N" labels; both newest-first. */
function whenSortKey(when: string | null): number {
  if (!when) return 0;
  if (/^\d{4}-\d{2}-\d{2}/.test(when)) {
    const t = Date.parse(when);
    if (!Number.isNaN(t)) return t;
  }
  const wk = /week\s*(\d+)/i.exec(when);
  if (wk) return Number(wk[1]);
  return 0;
}

type Outcome = "positive" | "partial" | "negative";
const OUTCOME_META: Record<Outcome, { icon: string; cls: string; label: string; counter: string }> = {
  positive: { icon: "✓", cls: "pos", label: "Improved", counter: "Successful" },
  partial: { icon: "📈", cls: "mid", label: "Mixed", counter: "Optimizing" },
  negative: { icon: "⚠", cls: "neg", label: "Declined", counter: "Underperforming" },
};

/** Infer an outcome class from note language (no numeric ROI in the source —
 *  we classify direction, we do NOT fabricate ROI percentages). */
function inferOutcome(text: string, action: string | null): Outcome {
  const t = (text + " " + (action ?? "")).toLowerCase();
  const pos = /(scale|increase|increas|grew|\bgrow|improv|recover|working|sold ?out|strong|boost|accelerat|\bup\b)/.test(t);
  const neg = /(\bstop|reduce|\bcut\b|\bpause|\bkill|declin|\bdrop|\bfell|underperform|wasted|weak|\bdown\b|lower|poor)/.test(t);
  if (pos && !neg) return "positive";
  if (neg && !pos) return "negative";
  return "partial";
}

function fmtWhen(when: string | null): string {
  if (!when) return "Undated";
  if (/^\d{4}-\d{2}-\d{2}/.test(when)) {
    const d = new Date(when + "T00:00:00Z");
    if (!isNaN(d.getTime()))
      return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }
  return when; // e.g. "Week 19" (weekly notes carry no date)
}

/** B3: Past Decisions Timeline — counters, outcome-classified cards, summary, legend. */
function PastDecisionsSection({ pd }: { pd: PastDecisions }) {
  if (pd.count === 0) {
    return (
      <section className="pl-card pl-card-elevated pl-card-padded" style={{ marginTop: "var(--spacing-16)" }}>
        <h2 className="t-title-sm">⏱ Past Decisions Timeline</h2>
        <p className="t-body-sm-short" style={{ color: "var(--content-secondary)", margin: "var(--spacing-8) 0 0" }}>
          No exact past decisions logged for this event yet — start by approving today’s verdict to build the loop.
          {" "}(Similar events’ context is shown separately below.)
        </p>
      </section>
    );
  }

  const items = [...pd.items]
    .sort((a, b) => whenSortKey(b.when) - whenSortKey(a.when))
    .map((it) => ({ ...it, outcome: inferOutcome(it.text, it.action) }));

  const n = items.length;
  const cnt = { positive: 0, partial: 0, negative: 0 };
  for (const it of items) cnt[it.outcome]++;
  const weeks = new Set(items.map((i) => i.when).filter(Boolean)).size;
  const pctOf = (x: number) => (n ? Math.round((x / n) * 100) : 0);

  const netTrend = cnt.positive > cnt.negative ? "improving" : cnt.negative > cnt.positive ? "declining" : "mixed";
  const worked = items.filter((i) => i.outcome === "positive").slice(0, 3);
  const mostImpactful = worked[0] ?? null;
  const takeaway =
    netTrend === "improving"
      ? "Most logged interventions moved performance up — the optimisation loop is working."
      : netTrend === "declining"
        ? "More interventions underperformed than helped — revisit the playbook for this event."
        : "Mixed results — several interventions didn't clearly move the needle.";

  const shown = items.slice(0, 12);
  const rest = items.slice(12);

  const Card = (it: (typeof items)[number], i: number) => {
    const m = OUTCOME_META[it.outcome];
    return (
      <div key={i} className="dca-tl-node">
        <span className={`dca-tl-icon dca-tl-icon--${m.cls}`} aria-hidden>{it.outcome === "positive" ? "✓" : it.outcome === "negative" ? "⚠" : "↗"}</span>
        <div className={`dca-tl-card${it.from_analog ? " dca-tl-card--analog" : ""}`}>
          <span className="dca-tl-date t-caption">{fmtWhen(it.when)}</span>
          <span className="dca-tl-title t-body-sm-strong">{it.action ?? SOURCE_LABEL[it.source] ?? "Note"}</span>
          {it.from_analog && <span className="dca-tl-analog t-caption">From {it.from_analog} · similar event</span>}
          <span className="dca-tl-sub t-caption">{it.text.length > 80 ? it.text.slice(0, 80) + "…" : it.text}</span>
          <span className={`dca-tl-pill dca-tl-pill--${m.cls}`}>{m.label} · inferred</span>
        </div>
      </div>
    );
  };

  return (
    <section className="pl-card pl-card-elevated pl-card-padded dca-tl" style={{ marginTop: "var(--spacing-16)" }}>
      {/* A — header + counters + legend */}
      <div className="dca-tl-head">
        <div>
          <h2 className="t-title-sm">⏱ Past Decisions Timeline</h2>
          <p className="t-caption" style={{ margin: "var(--spacing-2) 0 0", color: "var(--content-secondary)" }}>
            {pd.viaAnalogs ? `${n} decisions on similar events — no history on this event yet` : `${n} decisions logged`}
          </p>
        </div>
        <div className="dca-tl-legend t-caption">
          <span><span className="dca-tl-dot dca-tl-dot--pos" /> Improved</span>
          <span><span className="dca-tl-dot dca-tl-dot--mid" /> Mixed</span>
          <span><span className="dca-tl-dot dca-tl-dot--neg" /> Declined</span>
        </div>
      </div>
      <div className="dca-tl-counters">
        <div className="dca-tl-counter dca-tl-counter--pos"><span className="dca-tl-counter-n">{cnt.positive}</span><span className="t-caption">✓ Successful ({pctOf(cnt.positive)}%)</span></div>
        <div className="dca-tl-counter dca-tl-counter--mid"><span className="dca-tl-counter-n">{cnt.partial}</span><span className="t-caption">📈 Optimizing ({pctOf(cnt.partial)}%)</span></div>
        <div className="dca-tl-counter dca-tl-counter--neg"><span className="dca-tl-counter-n">{cnt.negative}</span><span className="t-caption">⚠ Underperforming ({pctOf(cnt.negative)}%)</span></div>
        <div className="dca-tl-counter"><span className="dca-tl-counter-n">{weeks}</span><span className="t-caption">📅 Distinct weeks</span></div>
      </div>

      {/* B — horizontal timeline */}
      <div className="dca-tl-track">{shown.map((it, i) => Card(it, i))}</div>
      {rest.length > 0 && (
        <details className="dca-why" style={{ marginTop: "var(--spacing-8)" }}>
          <summary className="dca-why-summary t-caption">See full history ({rest.length} more)</summary>
          <div className="dca-tl-track" style={{ marginTop: "var(--spacing-12)" }}>{rest.map((it, i) => Card(it, i + 100))}</div>
        </details>
      )}

      {/* C — summary panel */}
      <div className="dca-tl-summary">
        <div className="dca-tl-summary-col">
          <span className="t-label-sm">Overall outcome</span>
          <span className={`dca-tl-trend dca-tl-trend--${netTrend === "improving" ? "pos" : netTrend === "declining" ? "neg" : "mid"}`}>
            {netTrend === "improving" ? "▲ Improving" : netTrend === "declining" ? "▼ Declining" : "→ Mixed"} ({cnt.positive}↑ / {cnt.negative}↓ / {cnt.partial}~)
          </span>
        </div>
        <div className="dca-tl-summary-col">
          <span className="t-label-sm">What worked best</span>
          {worked.length ? (
            <ul className="dca-tl-worked t-caption">{worked.map((w, i) => <li key={i}>{w.action ?? (w.text.length > 50 ? w.text.slice(0, 50) + "…" : w.text)}</li>)}</ul>
          ) : <span className="t-caption" style={{ color: "var(--content-secondary)" }}>No clearly positive moves logged.</span>}
        </div>
        <div className="dca-tl-summary-col">
          <span className="t-label-sm">Key takeaway</span>
          <span className="t-caption" style={{ color: "var(--content-secondary)" }}>{takeaway}</span>
        </div>
      </div>
      {mostImpactful && (
        <div className="dca-tl-impact t-caption">
          <span className="t-label-sm">Most impactful move</span>{" "}
          {mostImpactful.action ?? "—"} <span className="dca-tl-pill dca-tl-pill--pos">Improved · inferred</span>{" "}
          <span style={{ color: "var(--content-secondary)" }}>({fmtWhen(mostImpactful.when)})</span>
        </div>
      )}
      <p className="t-caption" style={{ color: "var(--content-tertiary)", margin: "var(--spacing-8) 0 0" }}>
        Outcomes inferred from note language — no numeric ROI in the source data.
      </p>
    </section>
  );
}

/** Fix H — cross-event reference (analogs + affinity siblings). NOT this event's decisions. */
function SimilarEventPatterns({
  analogs, siblings, analogDecisions,
}: {
  analogs: AnalogEvent[];
  siblings: AffinitySibling[];
  analogDecisions: Record<string, PastDecisionItem[]>;
}) {
  const tops = analogs.slice(0, 3);
  const sibs = siblings.slice(0, 3);
  if (tops.length === 0 && sibs.length === 0) return null;
  const ctr = (x: number | null) => (x == null ? "n/a" : pctFmt(x));

  return (
    <section className="pl-card pl-card-elevated pl-card-padded dca-sim" style={{ marginTop: "var(--spacing-12)" }}>
      <h2 className="t-title-sm">Similar event patterns</h2>
      <p className="dca-sim-sub t-caption">Insights from analog events with a similar profile — cross-event reference, NOT decisions for this event.</p>
      <div className="dca-sim-grid">
        {tops.map((a) => (
          <div key={`a-${a.event_id}`} className="dca-sim-card">
            <span className="dca-sim-tag dca-sim-tag--analog">Analog</span>
            <span className="dca-sim-name t-body-sm-strong">{a.name || `Event ${a.event_id}`}</span>
            <span className="t-caption">Last 7d: ROAS {roasFmt(a.roas)} · Meta CTR {ctr(a.meta_ctr)} · Google CTR {ctr(a.google_ctr)} · sales {aed(a.sales_aed)}</span>
            {analogDecisions[a.event_id]?.length ? (
              <div className="dca-sim-worked">
                <span className="dca-sim-worked-h t-caption">What worked there:</span>
                <ul className="t-caption" style={{ margin: "var(--spacing-2) 0 0", paddingLeft: "var(--spacing-16)" }}>
                  {analogDecisions[a.event_id].slice(0, 2).map((d, i) => (
                    <li key={i}>{d.when ? `${d.when}: ` : ""}{d.action ? `${d.action} — ` : ""}{d.text.length > 90 ? d.text.slice(0, 90) + "…" : d.text}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ))}
        {sibs.map((s) => {
          const w = (s.winning_segments ?? [])[0];
          return (
            <div key={`s-${s.event_id}`} className="dca-sim-card">
              <span className="dca-sim-tag dca-sim-tag--sib">Affinity sibling · {s.affinity_norm.toFixed(2)}</span>
              <span className="dca-sim-name t-body-sm-strong">{s.name || `Event ${s.event_id}`}</span>
              <span className="t-caption">Currently running, last 7d: ROAS {roasFmt(s.roas)} · sales {aed(s.sales_aed)}</span>
              {w ? (
                <>
                  <span className="t-caption">Winning {w.source} segment: “{w.ad_name ?? w.campaign ?? "—"}” (ROAS {w.roas == null ? "n/a" : roasFmt(w.roas)})</span>
                  <span className="dca-sim-rec t-caption">Recommended: test this audience pattern in your own campaign (within-event only).</span>
                </>
              ) : (
                <span className="t-caption" style={{ color: "var(--content-secondary)" }}>No clearly-winning segment to borrow.</span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Lens metric tile: value + optional WoW pill + optional vs-cluster pill. */
function MetricTile({ t }: { t: Tile }) {
  return (
    <div className="dca-tile">
      <span className="dca-tile-label t-caption">{t.label}</span>
      <span className="dca-tile-value t-body-sm-strong">{t.value}</span>
      {t.wow && (
        <DeltaPill
          value={t.wow.pct * 100}
          good={t.wow.goodUp ? t.wow.pct >= 0 : t.wow.pct <= 0}
        />
      )}
      {t.cluster && (
        <span className={`dca-bench dca-bench--${t.cluster.cls}`}>
          {t.cluster.ratio.toFixed(2)}× cluster
        </span>
      )}
    </div>
  );
}

type Hero = { label: string; value: string; pill?: Wow; series?: number[] };
type LensDef = { name: string; key: LensName; window: string; tiles: Tile[]; hero?: Hero };

/** Per-lens status word triple [healthy, softening, collapsing] (Fix 11). */
const STATUS_WORDS: Record<LensName, [string, string, string]> = {
  internal: ["Demand healthy", "Watch closely", "Action needed"],
  meta: ["Meta strong", "Meta drifting", "Meta burning"],
  google: ["Google strong", "Google drifting", "Wasted spend"],
  ga4: ["Funnel healthy", "Funnel friction", "Funnel broken"],
  last_week: ["On track", "Loop detected", "Predicted wrong"],
  market: ["Tailwind", "Neutral", "Headwind"],
};

/** lens_score → status band (colour cls + glyph + per-lens word). */
function lensStatus(key: LensName, score: number | null): { word: string; cls: string; glyph: string } {
  if (score == null) return { word: "No data yet", cls: "nodata", glyph: "○" };
  const words = STATUS_WORDS[key];
  if (score < 30) return { word: words[0], cls: "good", glyph: "▲" };
  if (score <= 60) return { word: words[1], cls: "warn", glyph: "⚠" };
  return { word: words[2], cls: "bad", glyph: "▼" };
}

/** Tiny inline SVG sparkline (server-rendered, no client JS). */
function Sparkline({ data, cls }: { data: number[]; cls: string }) {
  const pts = (data ?? []).filter((n) => Number.isFinite(n));
  if (pts.length < 2) return null;
  const w = 120, h = 44, pad = 4;
  const min = Math.min(...pts), max = Math.max(...pts), range = max - min || 1;
  const step = (w - pad * 2) / (pts.length - 1);
  const xy = pts.map((v, i) => [pad + i * step, h - pad - ((v - min) / range) * (h - pad * 2)] as const);
  const path = xy.map((c, i) => `${i ? "L" : "M"}${c[0].toFixed(1)} ${c[1].toFixed(1)}`).join(" ");
  const last = xy[xy.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={`dca-spark dca-spark--${cls}`} aria-hidden>
      <path d={path} fill="none" strokeWidth="2" />
      <circle cx={last[0]} cy={last[1]} r="3.2" />
    </svg>
  );
}

/** Fix 11 — Option A lens card: status banner + hero number + sparkline + mini-tiles + Why. */
function LensCard({
  lens, lo, hasAnalysis, clusterFallback, analogFallback,
}: {
  lens: LensDef;
  lo: LensOutput | undefined;
  hasAnalysis: boolean;
  clusterFallback: string;
  analogFallback: string;
}) {
  const score = lo ? lo.lens_score : null;
  const st = lensStatus(lens.key, score);
  const bullets = lo?.diagnosis_bullets ?? [];
  const hero = lens.hero;

  return (
    <section className="pl-card pl-card-elevated dca-lenscard">
      {/* A — colored status banner */}
      <div className={`dca-lensbar dca-lensbar--${st.cls}`}>
        <span className="dca-lensbar-left">
          <span className="dca-lensbar-glyph" aria-hidden>{st.glyph}</span>
          <span className="dca-lensbar-word t-body-sm-strong">{st.word}</span>
          <span className="dca-lensbar-name t-caption">{lens.name}</span>
        </span>
        <span className="dca-lensbar-right t-caption">
          {lo ? `${lo.lens_score == null ? "no data" : `score ${lo.lens_score}`} · trust ${lo.confidence}` : lens.window}
        </span>
      </div>

      <div className="dca-lensbody">
        {/* B — hero metric + sparkline */}
        {hero && (
          <div className="dca-hero">
            <div className="dca-hero-main">
              <span className="dca-hero-label t-caption">{hero.label}</span>
              <span className="dca-hero-value">{hero.value}</span>
              {hero.pill && (
                <DeltaPill value={hero.pill.pct * 100} good={hero.pill.goodUp ? hero.pill.pct >= 0 : hero.pill.pct <= 0} />
              )}
            </div>
            {hero.series && (
              <div className="dca-hero-spark"><Sparkline data={hero.series} cls={st.cls} /></div>
            )}
          </div>
        )}

        {/* C — mini-tile grid (first 3 metrics) */}
        <div className="dca-tiles">
          {lens.tiles.slice(0, 3).map((t, i) => <MetricTile key={i} t={t} />)}
        </div>

        {/* D — collapsible Why */}
        {bullets.length > 0 ? (
          <details className="dca-why">
            <summary className="dca-why-summary t-caption">Why this is {st.word.toLowerCase()}</summary>
            <ul className="dca-why-list t-caption">
              {bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </details>
        ) : (
          <p className="dca-proof-empty t-caption">
            {hasAnalysis ? "No diagnosis returned for this lens" : "Not analysed yet — run the AI brain"}
          </p>
        )}

        {/* E — plain-English cluster + analog references */}
        <p className="dca-ref-line t-caption">Compared to {lo ? lo.cluster_benchmark_used : clusterFallback}</p>
        <p className="dca-ref-line t-caption" title="A specific similar event used as a direct comparison">
          {lo ? lo.analog_event_cited : analogFallback}
        </p>
      </div>
    </section>
  );
}

/** Plain-English cluster reference (no p50/n= jargon) — fallback when no AI string. */
function clusterLine(report: EventReport): string {
  const cb = report.clusterBaseline;
  if (!cb || !cb.matched) return "No comparable cluster of similar events found";
  const bits: string[] = [];
  if (cb.ctr_p50 != null) bits.push(`CTR ${(cb.ctr_p50 * 100).toFixed(1)}%`);
  if (cb.cpa_p50 != null) bits.push(`CPA AED ${Math.round(cb.cpa_p50)}`);
  if (cb.roas_p50 != null) bits.push(`ROAS ${cb.roas_p50.toFixed(1)}x`);
  const avg = bits.length ? ` (avg ${bits.join(" · ")})` : "";
  return `The average across ${cb.sample_size ?? "similar"} similar ${cb.cluster_category} events at ${cb.price_band} price${avg}`;
}

/** Plain-English analog reference — fallback when no AI string. */
function analogLine(report: EventReport, lensName: string): string {
  const a = report.analogs;
  if (!a || a.length === 0) return "No close analog event found";
  const top = a[0];
  const pct = (x: number | null) => (x === null ? "n/a" : (x * 100).toFixed(1) + "%");
  let metric: string;
  if (lensName === "Meta") metric = `Meta CTR ${pct(top.meta_ctr)}`;
  else if (lensName === "Google") metric = `Google CTR ${pct(top.google_ctr)}`;
  else metric = `ROAS ${top.roas.toFixed(1)}x`;
  return `Closest similar event: ${top.name} — ${metric}, sales AED ${Math.round(top.sales_aed).toLocaleString("en-US")} in the same window`;
}
