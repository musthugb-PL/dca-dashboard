/**
 * AI-brain orchestrator (P2.2): event → 6 lenses (Haiku ×5 + Sonar→Haiku) →
 * verdict (Sonnet) → BrainAnalysis. Pure compute + AI calls; persistence and
 * full-slot fan-out are wired separately (after first-output review).
 */

import { getEventReport } from "@/src/lib/data/events";
import { runAllLenses } from "./lenses";
import { synthesize } from "./synthesize";
import type { BrainAnalysis } from "./types";

export async function runBrain(
  eventId: number,
  dateFrom: string,
  dateTo: string,
): Promise<BrainAnalysis> {
  const report = await getEventReport(eventId, dateFrom, dateTo, {
    includePrior: true,
    includeCluster: true,
    includeAnalogs: true,
    includeAffinitySiblings: true,
    includePastDecisions: true,
    includeOwnSegments: true,
    includeInventory: true,
  });
  const eventName = report.event.name || `Event ${eventId}`;

  const lenses = await runAllLenses(report, eventName);
  const verdict = await synthesize(report, eventName, lenses);

  return { event_id: eventId, generated_at: new Date().toISOString(), lenses, verdict };
}
