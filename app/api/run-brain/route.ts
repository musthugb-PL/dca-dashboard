import { type NextRequest } from "next/server";
import { runBrain } from "@/src/lib/ai-brain/run-brain";
import { saveBrainAnalysis } from "@/src/lib/ai-brain/persist";
import { reviewWindow, mostRecentSlot, type Slot } from "@/src/lib/slot";
import { getSupabase } from "@/lib/supabase";

// Node runtime — runBrain uses the BigQuery node client + OpenRouter.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // one brain run is ~40-90s

/** Resolve the campaign's review slot from the ledger; fall back to today's. */
async function resolveSlot(eventId: string, today: Date): Promise<Slot> {
  try {
    const { data } = await getSupabase()
      .from("dca_campaign_ledger")
      .select("review_slot")
      .eq("event_id", eventId)
      .maybeSingle();
    const s = data?.review_slot != null ? Number(data.review_slot) : null;
    if (s === 1 || s === 2 || s === 3) return s;
  } catch {
    /* fall through */
  }
  return mostRecentSlot(today);
}

/**
 * POST /api/run-brain { event_id } — run the AI brain once for one event and
 * persist it (same-day upsert). B5: "Re-run AI brain" button on each card.
 * Auth: any @platinumlist.net SSO session in prod; open on localhost/dev.
 */
export async function POST(req: NextRequest) {
  try {
    if (process.env.NODE_ENV === "production") {
      const email = req.headers.get("x-user-email") || "";
      if (!email.endsWith("@platinumlist.net")) {
        return Response.json({ ok: false, error: "unauthorised — @platinumlist.net only" }, { status: 401 });
      }
    }
    const { event_id } = await req.json();
    if (!event_id) return Response.json({ ok: false, error: "event_id required" }, { status: 400 });

    const today = new Date();
    const { dateFrom, dateTo } = reviewWindow(today);
    const slot = await resolveSlot(String(event_id), today);

    const t0 = Date.now();
    const analysis = await runBrain(Number(event_id), dateFrom, dateTo);
    await saveBrainAnalysis(analysis, slot);
    const seconds = Math.round((Date.now() - t0) / 1000);
    console.log(`[api/run-brain] event ${event_id} slot ${slot} → ${analysis.verdict.recommended_action} in ${seconds}s`);
    return Response.json({ ok: true, action: analysis.verdict.recommended_action, slot, seconds });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/run-brain] error:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
