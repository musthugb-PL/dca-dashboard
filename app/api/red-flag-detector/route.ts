import { runRedFlagDetection } from "@/src/lib/data/red-flag-run";

// Node runtime — getEventReport uses the BigQuery node client (not Deno-compatible).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // heavy: getEventReport per campaign

/**
 * POST /api/red-flag-detector — scans today's slot, writes hits to
 * dca_red_flag_events. Triggered by the daily cron (Mon/Wed/Fri 06:00 UAE).
 */
async function handle() {
  try {
    const result = await runRedFlagDetection(new Date());
    console.log("[red-flag-detector]", JSON.stringify({ ...result, sample: undefined }));
    return Response.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[red-flag-detector] error:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Vercel cron invokes via GET; POST kept for manual triggers.
export const GET = handle;
export const POST = handle;
