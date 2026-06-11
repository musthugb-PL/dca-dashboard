import { type NextRequest } from "next/server";
import { getReviewCards } from "@/src/lib/data/dashboard";
import { slotForDate, mostRecentSlot, type Slot } from "@/src/lib/slot";

export const dynamic = "force-dynamic";

/** GET /api/review-cards?slot=1|2|3 → ReviewCardsResult JSON. */
export async function GET(req: NextRequest) {
  const today = new Date();
  const p = req.nextUrl.searchParams.get("slot");
  const slot: Slot =
    p && ["1", "2", "3"].includes(p)
      ? (Number(p) as Slot)
      : (slotForDate(today) ?? mostRecentSlot(today));

  try {
    const result = await getReviewCards(slot, today);
    console.log(
      `[api/review-cards] slot ${slot} · window ${result.dateFrom}→${result.dateTo} · ` +
        `total=${result.counts.totalInSlot} running=${result.counts.running} ` +
        `eligible=${result.counts.eligible} cards=${result.cards.length}`,
    );
    return Response.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/review-cards] error:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
