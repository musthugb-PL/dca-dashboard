/**
 * Delta indicator pill — green ▲ for a good move, red ▼ for a bad one.
 * Matches the Marketing Insights Dashboard's "▼-0.4%" / "▲+34.5%" style.
 *
 * Ready for use once week-over-week deltas are computed in the data layer
 * (P2.2). `good` decides colour independently of arrow direction, because a
 * falling CPA is good while a falling CTR is bad.
 */
export default function DeltaPill({
  value,
  good,
}: {
  value: number; // signed percentage, e.g. -0.4 or 34.5
  good: boolean; // true → green, false → red
}) {
  const arrow = value >= 0 ? "▲" : "▼";
  const sign = value >= 0 ? "+" : "";
  return (
    <span className={`dca-delta ${good ? "dca-delta--up" : "dca-delta--down"}`}>
      {arrow}
      {sign}
      {value.toFixed(1)}%
    </span>
  );
}
