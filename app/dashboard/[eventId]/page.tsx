import Link from "next/link";
import { getEventReport, type EventReport } from "@/src/lib/data/events";
import { getSupabase } from "@/lib/supabase";
import { reviewWindow, daysSince } from "@/src/lib/slot";
import { aed, intFmt, roasFmt, pctFmt } from "@/src/lib/format";
import { lensDotClass } from "@/src/lib/lens";
import { getLatestBrainAnalysis } from "@/src/lib/ai-brain/persist";
import type { BrainAnalysis, LensName, LensOutput } from "@/src/lib/ai-brain/types";
import { getPastDecisionsContext } from "@/src/lib/data/lens5";
import type { PastDecisions } from "@/src/lib/data/events";
import DeltaPill from "@/app/components/DeltaPill";

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
  try {
    const sb = getSupabase();
    const { data } = await sb
      .from("dca_campaign_ledger")
      .select("primary_campaign_manager,event_ids,campaign_start_date")
      .eq("event_id", params.eventId)
      .maybeSingle();
    if (data) {
      manager = data.primary_campaign_manager ?? null;
      eventIds = data.event_ids ?? [params.eventId];
      daysRunning = daysSince(data.campaign_start_date, today);
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

  // Fix 6: past decisions for this event (4 sources, fuzzy name match — same as Lens 5).
  let pastDecisions: PastDecisions = { items: [], count: 0 };
  try {
    pastDecisions = await getPastDecisionsContext(Number(params.eventId), report.event.name || "");
  } catch {
    /* decision history is best-effort */
  }

  const cb = report.clusterBaseline;
  const d = report.deltas;

  // ---- per-lens tile sets (real metrics + WoW + cluster comparison) ----
  // Note: overall ROAS (sales/spend) is NOT compared to the cluster's marketing
  // ROAS p50 — different metrics (org "don't conflate" rule); WoW only here.
  const internalTiles: Tile[] = [
    { label: "Sales", value: aed(report.kpis.total_sales_aed), wow: wowCmp(d?.total_sales, true) },
    { label: "Tickets", value: intFmt(report.kpis.tickets_sold), wow: wowCmp(d?.tickets, true) },
    { label: "Orders", value: intFmt(report.sales.orders_count) },
    { label: "Avg price", value: aed(report.kpis.avg_ticket_price) },
    { label: "Avg tix/order", value: report.kpis.avg_tickets_per_order.toFixed(2) },
    { label: "ROAS (total)", value: roasFmt(report.kpis.total_roas), wow: wowCmp(d?.total_roas, true) },
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

  const LENSES: { name: string; key: LensName; window: string; tiles: Tile[] }[] = [
    { name: "Internal", key: "internal", window: "3d vs prior 3d", tiles: internalTiles },
    { name: "Meta", key: "meta", window: "7d vs T-7", tiles: metaTiles },
    { name: "Google", key: "google", window: "7d vs T-7", tiles: googleTiles },
    { name: "GA4", key: "ga4", window: "7d vs T-7", tiles: ga4Tiles },
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

        {/* b. KPI strip — with WoW deltas (vs prior 7d) */}
        <section className="pl-card pl-card-elevated pl-card-padded" style={{ marginTop: "var(--spacing-16)" }}>
          <h2 className="t-title-sm">KPIs {report.deltas && <span className="dca-lens-window t-caption">(vs prior 7d)</span>}</h2>
          <div className="dca-report-grid">
            <KpiTile label="Sales" value={aed(report.kpis.total_sales_aed)} d={report.deltas?.total_sales.pct} goodUp />
            <KpiTile label="Spend" value={aed(report.kpis.total_spend_aed)} d={report.deltas?.total_spend.pct} goodUp={false} />
            <KpiTile label="ROAS" value={roasFmt(report.kpis.total_roas)} d={report.deltas?.total_roas.pct} goodUp />
            <KpiTile label="Tickets" value={intFmt(report.kpis.tickets_sold)} d={report.deltas?.tickets.pct} goodUp />
          </div>
        </section>

        {/* b2. Past decisions (Fix 6) — collapsed by default, above the lenses */}
        <PastDecisionsSection pd={pastDecisions} />

        {/* c. Six lens sections */}
        <div className="dca-lens-sections">
          {LENSES.map((lens) => {
            const lo = lensByKey.get(lens.key);
            const score = lo ? lo.lens_score : null;
            return (
              <section key={lens.name} className="pl-card pl-card-elevated pl-card-padded">
                <div className="dca-lens-head">
                  <span className={`dca-lens-dot ${lensDotClass(score)}`} aria-hidden />
                  <h2 className="t-title-sm">{lens.name}</h2>
                  {lo && (
                    <span className="dca-chip">
                      score {lo.lens_score} · {lo.confidence}
                    </span>
                  )}
                  <span className="dca-lens-window t-caption">{lens.window}</span>
                </div>
                <div className="dca-tiles">
                  {lens.tiles.map((t, i) => (
                    <MetricTile key={i} t={t} />
                  ))}
                </div>
                {lo && lo.diagnosis_bullets.length > 0 ? (
                  <ul className="dca-diag t-caption">
                    {lo.diagnosis_bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                ) : (
                  <ul className="dca-diag t-caption">
                    <li>{analysis ? "No diagnosis bullets returned for this lens" : "Not analysed yet — run the AI brain"}</li>
                  </ul>
                )}
                <p className="dca-ref-line t-caption">
                  Cluster: {lo ? lo.cluster_benchmark_used : clusterLine(report)}
                </p>
                <p className="dca-ref-line t-caption" title="Analog = a specific similar event used as a direct comparison">
                  Analog: {lo ? lo.analog_event_cited : analogLine(report, lens.name)}
                </p>
              </section>
            );
          })}
        </div>

        {/* d. Verdict */}
        <section className="pl-card pl-card-elevated pl-card-padded dca-verdict">
          <h2 className="t-title-base">Verdict</h2>

          {analysis ? (
            <>
              <div className="dca-verdict-action">
                <span className={`dca-ai-verb dca-ai-verb--${analysis.verdict.recommended_action.toLowerCase()}`}>
                  {analysis.verdict.recommended_action}
                </span>
                <span className="dca-lens-window t-caption">
                  {verdictLensLine(analysis)} · AI confidence {analysis.verdict.confidence}
                </span>
              </div>

              <div className="dca-checklist">
                {analysis.verdict.tactical_steps.length > 0 ? (
                  analysis.verdict.tactical_steps.map((s) => (
                    <label key={s.id} className="dca-check-row t-body-sm-short">
                      <input type="checkbox" disabled />
                      <span>
                        <span className="dca-chip">{s.channel}</span> {s.text}
                      </span>
                    </label>
                  ))
                ) : (
                  <p className="t-caption">No tactical steps returned.</p>
                )}
              </div>

              <p className="dca-strategic t-body-sm-short">
                {analysis.verdict.strategic_context || "No strategic context returned."}
              </p>

              <div className="dca-outcome">
                <label className="t-label-sm">Expected outcome (required before approve — P2.3)</label>
                <textarea
                  disabled
                  defaultValue={analysis.verdict.expected_outcome_template}
                  placeholder="AI-suggested prediction will seed this field"
                />
              </div>
            </>
          ) : (
            <>
              <div className="dca-verdict-action">
                <span className="dca-ai-verb dca-ai-verb--pending">Not analysed</span>
                <span className="dca-lens-window t-caption">Run the AI brain for this event</span>
              </div>
              <p className="dca-strategic t-body-sm-short">
                No persisted analysis for this event yet.
              </p>
            </>
          )}

          <div className="dca-verdict-actions">
            {/* Approve / Override flow ships in P2.3 */}
            <button type="button" className="pl-btn pl-btn-primary pl-btn-m" disabled>
              Approve
            </button>
            <button type="button" className="pl-btn pl-btn-outline pl-btn-m" disabled>
              Override
            </button>
          </div>
        </section>
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

/** Fix 6: collapsible "Past decisions on this event" — 4 sources, fuzzy-matched. */
function PastDecisionsSection({ pd }: { pd: PastDecisions }) {
  if (pd.count === 0) {
    return (
      <section className="pl-card pl-card-elevated pl-card-padded" style={{ marginTop: "var(--spacing-16)" }}>
        <h2 className="t-title-sm">Past decisions</h2>
        <p className="t-body-sm-short" style={{ color: "var(--content-secondary)", margin: "var(--spacing-8) 0 0" }}>
          No past decisions logged for this event yet — start by approving today’s verdict to build the loop.
        </p>
      </section>
    );
  }
  const items = [...pd.items].sort((a, b) => whenSortKey(b.when) - whenSortKey(a.when));
  return (
    <details className="pl-card pl-card-elevated pl-card-padded dca-history" style={{ marginTop: "var(--spacing-16)" }}>
      <summary className="dca-history-summary t-body-sm-strong">
        Past decisions: {pd.count} logged · click to expand
      </summary>
      <ul className="dca-timeline">
        {items.map((it, i) => (
          <li key={i} className="dca-timeline-item">
            <div className="dca-timeline-head">
              <span className="t-body-sm-strong">{it.when ? `Week of ${it.when}` : "Undated"}</span>
              {it.action && <span className="dca-chip">{it.action}</span>}
              <span className="dca-chip">
                {SOURCE_LABEL[it.source] ?? it.source}
                {it.matched_by === "name" ? " · name-matched" : ""}
              </span>
            </div>
            <p className="dca-timeline-text t-caption">
              {it.text.length > 200 ? it.text.slice(0, 200) + "…" : it.text}
            </p>
            {it.matched_by === "name" && it.event_name && (
              <p className="t-caption" style={{ color: "var(--content-tertiary)", margin: 0 }}>
                matched note: “{it.event_name}”
              </p>
            )}
          </li>
        ))}
      </ul>
    </details>
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

const LENS_LABEL: Record<LensName, string> = {
  internal: "Internal",
  meta: "Meta",
  google: "Google",
  ga4: "GA4",
  last_week: "Last week",
  market: "Market",
};

/** "Primary: Meta · Contributing: Internal, GA4" line under the verdict verb. */
function verdictLensLine(analysis: BrainAnalysis): string {
  const v = analysis.verdict;
  const primary = v.primary_lens ? `Primary: ${LENS_LABEL[v.primary_lens]}` : "No single primary lens";
  const contributing = v.contributing_lenses.length
    ? ` · Contributing: ${v.contributing_lenses.map((k) => LENS_LABEL[k]).join(", ")}`
    : "";
  return primary + contributing;
}

function clusterLine(report: EventReport): string {
  const cb = report.clusterBaseline;
  if (!cb) return "Cluster baseline: —";
  if (!cb.matched) {
    return `Cluster baseline: no match (category "${cb.event_category || "?"}" / band ${cb.price_band})`;
  }
  const pct = (x: number | null) => (x === null ? "?" : (x * 100).toFixed(2) + "%");
  const aedp = (x: number | null) => (x === null ? "?" : "AED " + Math.round(x));
  const roasp = (x: number | null) => (x === null ? "?" : x.toFixed(1) + "x");
  return `Cluster ${cb.cluster_category} / ${cb.price_band} (n=${cb.sample_size}, ${cb.strategy}): CTR p50 ${pct(cb.ctr_p50)} · CPA p50 ${aedp(cb.cpa_p50)} · ROAS p50 ${roasp(cb.roas_p50)}`;
}

function analogLine(report: EventReport, lensName: string): string {
  const a = report.analogs;
  if (!a || a.length === 0) return "Analog: none found";
  const top = a[0];
  const pct = (x: number | null) => (x === null ? "n/a" : (x * 100).toFixed(2) + "%");
  let metric: string;
  if (lensName === "Meta") metric = `Meta CTR ${pct(top.meta_ctr)}`;
  else if (lensName === "Google") metric = `Google CTR ${pct(top.google_ctr)}`;
  else metric = `ROAS ${top.roas.toFixed(1)}x`;
  return `Analog: ${top.event_id} "${top.name}" — ${metric}, sales AED ${Math.round(top.sales_aed)} (${a.length} of top-3 shown)`;
}
