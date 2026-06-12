import Link from "next/link";
import type { ReviewCard, LensSeverity } from "@/src/lib/data/dashboard";
import { aed, intFmt, roasFmt } from "@/src/lib/format";
import { LENS_NAMES } from "@/src/lib/lens";
import { cardReason } from "@/src/lib/ai-brain/summary";

function dotClassForSeverity(sev: LensSeverity | undefined): string {
  if (sev === "red") return "dca-lens-dot--red";
  if (sev === "yellow") return "dca-lens-dot--yellow";
  return "dca-lens-dot--grey";
}

function FlagPill({ flags }: { flags: ReviewCard["flags"] }) {
  if (flags.total === 0) return <span className="dca-chip">0 flags</span>;
  const label = `${flags.total} flag${flags.total === 1 ? "" : "s"}`;
  if (flags.red > 0)
    return <span className="pl-status-tag pl-status-tag--alert">{label}</span>;
  return <span className="pl-status-tag pl-status-tag--caution">{label}</span>;
}

/** Status → PL status-tag variant. running=success, paused=caution, else neutral chip. */
function StatusPill({ status }: { status: string | null }) {
  const s = (status ?? "").toLowerCase();
  if (s === "running")
    return <span className="pl-status-tag pl-status-tag--success">Running</span>;
  if (s === "paused")
    return <span className="pl-status-tag pl-status-tag--caution">Paused</span>;
  return <span className="dca-chip">{status || "Unknown"}</span>;
}

export default function DecisionCard({ card }: { card: ReviewCard }) {
  const { row, primaryEventId, daysSinceLaunch, report, error, analysis } = card;
  const ids = row.event_ids ?? [primaryEventId];
  const isFestival = ids.length > 1;

  const verb = analysis?.verdict.recommended_action ?? null;
  const reason = analysis ? cardReason(analysis) : null;

  const eventRef = isFestival
    ? `Landing page ${ids[0]} + ${ids.length - 1} more`
    : `Event ${primaryEventId}`;

  return (
    <article className="pl-card pl-card-elevated pl-card-padded">
      {/* Header row */}
      <div className="dca-card-head">
        <h3 className="dca-card-title t-title-base">{row.event_name || "Untitled event"}</h3>
        {isFestival && <span className="dca-chip dca-chip--count">{ids.length} events</span>}
        <StatusPill status={row.status} />
        {/* Review status — Pending until the approve/override flow ships (P2.2) */}
        <span className="dca-chip">Pending</span>
        <span className="dca-spacer" />
        {/* Red Flag pill — live count from dca_red_flag_events (today's slot) */}
        <FlagPill flags={card.flags} />
      </div>

      {/* Subtitle */}
      <div className="dca-subtitle t-caption">
        {row.country && <span>{row.country}</span>}
        {row.primary_campaign_manager && (
          <>
            <span className="dca-dot-sep">·</span>
            <span>{row.primary_campaign_manager}</span>
          </>
        )}
        <span className="dca-dot-sep">·</span>
        <span>
          {daysSinceLaunch !== null ? `${daysSinceLaunch} days since launch` : "launch date n/a"}
        </span>
        <span className="dca-dot-sep">·</span>
        <span>{eventRef}</span>
      </div>

      {/* AI brain summary (P2.2): recommended action verb + one-line reason */}
      <div className="dca-ai-row">
        {verb ? (
          <>
            <span className={`dca-ai-verb dca-ai-verb--${verb.toLowerCase()}`}>{verb}</span>
            <span className="dca-ai-reason t-caption">
              {reason ?? "No diagnosis bullet returned"}
            </span>
          </>
        ) : (
          <>
            <span className="dca-ai-verb dca-ai-verb--pending">Not analysed</span>
            <span className="dca-ai-reason t-caption">Run the AI brain for this slot</span>
          </>
        )}
      </div>

      {/* Stats grid */}
      {error ? (
        <p className="dca-subtitle t-caption">Report unavailable: {error}</p>
      ) : report ? (
        <div className="dca-stats">
          <Stat label="Sales" value={aed(report.kpis.total_sales_aed)} />
          <Stat label="Spend" value={aed(report.kpis.total_spend_aed)} />
          <Stat label="ROAS" value={roasFmt(report.kpis.total_roas)} />
          <Stat label="Tickets" value={intFmt(report.kpis.tickets_sold)} />
        </div>
      ) : null}

      {/* Lens dots — coloured by today's Red Flags (Internal / Meta / Google) */}
      <div className="dca-lenses">
        {LENS_NAMES.map((l) => {
          const sev = (card.flags.lens as Record<string, LensSeverity | undefined>)[l];
          return (
            <div key={l} className="dca-lens">
              <span className={`dca-lens-dot ${dotClassForSeverity(sev)}`} aria-hidden />
              <span className="dca-lens-label t-caption">{l}</span>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="dca-card-foot">
        <Link
          className="pl-btn pl-btn-outline pl-btn-s"
          href={`/dashboard/${encodeURIComponent(ids[0])}`}
        >
          Open report →
        </Link>
      </div>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="dca-stat">
      <span className="dca-stat-label t-caption">{label}</span>
      <span className="dca-stat-value t-title-sm">{value}</span>
    </div>
  );
}
