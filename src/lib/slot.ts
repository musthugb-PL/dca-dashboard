/**
 * Review-slot + date helpers (CLAUDE.md slot mapping: Mon=1, Wed=2, Fri=3).
 */

export type Slot = 1 | 2 | 3;

/** JS getDay(): Sun=0 … Sat=6. Mon→1, Wed→2, Fri→3; other days → null. */
export function slotForDate(d: Date): Slot | null {
  switch (d.getDay()) {
    case 1: return 1; // Monday
    case 3: return 2; // Wednesday
    case 5: return 3; // Friday
    default: return null;
  }
}

export function slotDayLabel(slot: Slot): "Monday" | "Wednesday" | "Friday" {
  return slot === 1 ? "Monday" : slot === 2 ? "Wednesday" : "Friday";
}

/** Most recent review slot for any day (used as an off-day preview fallback). */
export function mostRecentSlot(d: Date): Slot {
  const day = d.getDay(); // Sun=0..Sat=6
  if (day === 1 || day === 2) return 1; // Mon/Tue → last review Mon
  if (day === 3 || day === 4) return 2; // Wed/Thu → last review Wed
  return 3; // Fri/Sat/Sun → last review Fri
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

/** Whole days between two ISO dates (b − a). Null-safe on bad input. */
export function daysSince(startIso: string | null, today: Date): number | null {
  if (!startIso) return null;
  const start = new Date(startIso + "T00:00:00");
  if (isNaN(start.getTime())) return null;
  const ms = today.getTime() - start.getTime();
  return Math.floor(ms / 86_400_000);
}
