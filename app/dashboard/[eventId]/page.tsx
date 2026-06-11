import Link from "next/link";
import { getEventReport, type EventReport } from "@/src/lib/data/events";
import { getSupabase } from "@/lib/supabase";
import { isoDate, addDays, daysSince } from "@/src/lib/slot";
import { aed, intFmt, roasFmt, pctFmt } from "@/src/lib/format";
import { lensDotClass } from "@/src/lib/lens";

export const dynamic = "force-dynamic";

type Tile = { label: string; value: string };

export default async function EventReportPage({ params }: { params: { eventId: string } }) {
  const today = new Date();
  const dateTo = isoDate(today);
  const dateFrom = isoDate(addDays(today, -7));

  let report: EventReport | null = null;
  let error: string | null = null;
  try {
    report = await getEventReport(Number(params.eventId), dateFrom, dateTo);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
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

  // ---- per-lens tile sets (real where the data layer reaches) ----
  const internalTiles: Tile[] = [
    { label: "Sales", value: aed(report.kpis.total_sales_aed) },
    { label: "Tickets", value: intFmt(report.kpis.tickets_sold) },
    { label: "Orders", value: intFmt(report.sales.orders_count) },
    { label: "Avg price", value: aed(report.kpis.avg_ticket_price) },
    { label: "Avg tix/order", value: report.kpis.avg_tickets_per_order.toFixed(2) },
    { label: "ROAS", value: roasFmt(report.kpis.total_roas) },
  ];
  const metaTiles: Tile[] = meta
    ? [
        { label: "Spend", value: aed(meta.spend) },
        { label: "Tickets", value: intFmt(meta.tickets) },
        { label: "Revenue", value: aed(meta.revenue) },
        { label: "CPA", value: aed(meta.cpa) },
        { label: "ROAS", value: roasFmt(meta.roas) },
        { label: "CTR", value: pctFmt(meta.ctr) },
      ]
    : [{ label: "Meta", value: "no spend in window" }];
  const googleTiles: Tile[] = google
    ? [
        { label: "Spend", value: aed(google.spend) },
        { label: "Tickets", value: intFmt(google.tickets) },
        { label: "Revenue", value: aed(google.revenue) },
        { label: "CPA", value: aed(google.cpa) },
        { label: "ROAS", value: roasFmt(google.roas) },
        { label: "CTR", value: pctFmt(google.ctr) },
      ]
    : [{ label: "Google", value: "no spend in window" }];
  const ga4Tiles: Tile[] = [
    { label: "LP users", value: intFmt(f.users_on_lp) },
    { label: "Add to cart", value: intFmt(f.users_add_to_cart) },
    { label: "Checkout", value: intFmt(f.users_with_checkout) },
    { label: "Purchase", value: intFmt(f.users_with_purchase) },
  ];
  const pendingTiles: Tile[] = [
    { label: "—", value: "pending P2.2" },
    { label: "—", value: "pending P2.2" },
  ];

  const LENSES: { name: string; window: string; tiles: Tile[] }[] = [
    { name: "Internal", window: "3d vs prior 3d", tiles: internalTiles },
    { name: "Meta", window: "7d vs T-7", tiles: metaTiles },
    { name: "Google", window: "7d vs T-7", tiles: googleTiles },
    { name: "GA4", window: "7d vs T-7", tiles: ga4Tiles },
    { name: "Last week", window: "last 4 weeks", tiles: pendingTiles },
    { name: "Market", window: "past 7d + next 14d", tiles: pendingTiles },
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

        {/* b. KPI strip */}
        <section className="pl-card pl-card-elevated pl-card-padded" style={{ marginTop: "var(--spacing-16)" }}>
          <h2 className="t-title-sm">KPIs</h2>
          <div className="dca-report-grid">
            <Tile label="Sales" value={aed(report.kpis.total_sales_aed)} />
            <Tile label="Spend" value={aed(report.kpis.total_spend_aed)} />
            <Tile label="ROAS" value={roasFmt(report.kpis.total_roas)} />
            <Tile label="Tickets" value={intFmt(report.kpis.tickets_sold)} />
          </div>
        </section>

        {/* c. Six lens sections */}
        <div className="dca-lens-sections">
          {LENSES.map((lens) => (
            <section key={lens.name} className="pl-card pl-card-elevated pl-card-padded">
              <div className="dca-lens-head">
                <span className={`dca-lens-dot ${lensDotClass(null)}`} aria-hidden />
                <h2 className="t-title-sm">{lens.name}</h2>
                <span className="dca-lens-window t-caption">{lens.window}</span>
              </div>
              <div className="dca-tiles">
                {lens.tiles.map((t, i) => (
                  <div key={i} className="dca-tile">
                    <span className="dca-tile-label t-caption">{t.label}</span>
                    <span className="dca-tile-value t-body-sm-strong">{t.value}</span>
                  </div>
                ))}
              </div>
              <ul className="dca-diag t-caption">
                <li>Diagnosis (P2.2 pending)</li>
                <li>Diagnosis (P2.2 pending)</li>
              </ul>
              <p className="dca-ref-line t-caption">Cluster baseline: [pending P2.2 join]</p>
              <p className="dca-ref-line t-caption">Analog: [pending P2.2 similar-event pull]</p>
            </section>
          ))}
        </div>

        {/* d. Verdict */}
        <section className="pl-card pl-card-elevated pl-card-padded dca-verdict">
          <h2 className="t-title-base">Verdict</h2>
          <div className="dca-verdict-action">
            <span className="dca-ai-verb">Recommended action: PENDING P2.2</span>
          </div>

          <div className="dca-checklist">
            {[1, 2, 3].map((n) => (
              <label key={n} className="dca-check-row t-body-sm-short">
                <input type="checkbox" disabled />
                <span>Step {n} — pending P2.2</span>
              </label>
            ))}
          </div>

          <p className="dca-strategic t-body-sm-short">Strategic context: [P2.2 pending]</p>

          <div className="dca-outcome">
            <label className="t-label-sm">Expected outcome (required)</label>
            <textarea
              disabled
              placeholder="Approve enabled once P2.2 ships"
            />
          </div>

          <div className="dca-verdict-actions">
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
