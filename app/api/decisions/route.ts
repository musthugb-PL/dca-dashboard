import { type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/decisions — log an approve/override decision to dca_decisions (B4).
 *
 * Maps the UI payload onto the existing dca_decisions columns:
 *   ai_recommended_action → ai_suggested_action
 *   user_approved_action  → final_action
 *   approved/dismissed steps + manual_review_required → ai_recommendations (jsonb)
 *   expected_outcome      → expected_outcome
 *   decided_by            → approved_by (x-user-email header, else local dev)
 *
 * This logs the human decision (Sacred Rule #1 — it does NOT execute any ad
 * action; the feedback loop / strategist acts on it).
 */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b?.event_id) return Response.json({ ok: false, error: "event_id required" }, { status: 400 });

    const approvedBy = req.headers.get("x-user-email") || "local-dev@platinumlist.net";
    const slot = b.slot != null ? Number(b.slot) : null;

    const row = {
      campaign_id: String(b.event_id), // placeholder — no ad campaign id at this layer
      event_id: String(b.event_id),
      review_slot: slot,
      review_date: new Date().toISOString().slice(0, 10),
      ai_suggested_action: b.ai_recommended_action ?? null,
      final_action: b.user_approved_action ?? b.ai_recommended_action ?? null,
      expected_outcome: b.expected_outcome ?? null,
      approved_by: approvedBy,
      ai_recommendations: {
        approved_steps: b.approved_steps ?? [],
        dismissed_steps: b.dismissed_steps ?? [],
        manual_review_required: !!b.manual_review_required,
      },
      reasoning: `Approver ${approvedBy} kept ${b.approved_steps?.length ?? 0} step(s), overrode ${b.dismissed_steps?.length ?? 0}.`,
    };

    const { error } = await getSupabase().from("dca_decisions").insert(row);
    if (error) throw new Error(error.message);

    console.log(`[api/decisions] logged event ${row.event_id} slot ${slot} → ${row.final_action} by ${approvedBy}`);
    return Response.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/decisions] error:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
