import { type NextRequest } from "next/server";
import { runSlotFanout } from "@/src/lib/ai-brain/slot-fanout";
import type { Slot } from "@/src/lib/slot";

// Node runtime — runBrain uses the BigQuery node client + OpenRouter.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET/POST /api/run-brain-fanout?slot=1|2|3 — run the AI brain across every
 * eligible campaign in the slot and persist each. Triggered by the day-before
 * crons in vercel.json (Sun/Tue/Thu 18:00 UTC = 22:00 UAE).
 *
 * ⚠ TIMEOUT CAVEAT: a full slot (12+ events × ~40-90s) takes 15-25 min, which
 * exceeds Vercel's function limit (Hobby 60s; this route caps at 300s). On
 * production this needs Vercel Pro with extended duration OR a background queue
 * (e.g. chunk the slot, or move to a Supabase Edge cron / external worker).
 * Locally / for small slots it runs to completion.
 */
async function handle(req: NextRequest) {
  const p = req.nextUrl.searchParams.get("slot");
  if (!p || !["1", "2", "3"].includes(p)) {
    return Response.json({ ok: false, error: "slot=1|2|3 required" }, { status: 400 });
  }
  const slot = Number(p) as Slot;
  try {
    const r = await runSlotFanout(slot, new Date());
    console.log("[api/run-brain-fanout]", JSON.stringify({ ...r, failures: r.failures.length }));
    return Response.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/run-brain-fanout] error:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
