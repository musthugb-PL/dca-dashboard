/**
 * Upsert + soft-delete of dca_campaign_ledger (shared, runtime-agnostic).
 *
 * Writes ONLY to dca_campaign_ledger (Sacred Rule: never touch anything
 * outside dca_*). Never deletes — rows missing from the sheet are marked
 * status='inactive' (soft-delete, user-approved).
 *
 * Upsert strategy is constraint-independent: we look up existing
 * event_id → id, attach the primary key to matching records, then upsert on
 * the primary key. This works whether or not event_id has a unique index,
 * and batches both inserts and updates efficiently.
 *
 * The Supabase client is passed in (typed structurally) so the same code runs
 * under Node (@supabase/supabase-js) and Deno (Edge Function) without import
 * differences.
 */

import type { LedgerRecord } from "./ledger-transform.ts";

// Minimal structural type — avoids importing supabase-js (differs per runtime).
export interface SupabaseLike {
  from(table: string): any;
}

const TABLE = "dca_campaign_ledger";
const BATCH = 500;

export type SyncResult = {
  upserted: number;
  softDeletedIds: string[];
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Page through all existing event_id → id, bypassing PostgREST's row cap. */
async function fetchExistingIdMap(
  client: SupabaseLike,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await client
      .from(TABLE)
      .select("id, event_id")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`fetch existing ids: ${error.message}`);
    const rows = (data ?? []) as { id: number; event_id: string }[];
    for (const r of rows) if (r.event_id) map.set(String(r.event_id), r.id);
    if (rows.length < PAGE) break;
  }
  return map;
}

export async function syncLedger(
  client: SupabaseLike,
  records: LedgerRecord[],
  nowIso: string = new Date().toISOString(),
): Promise<SyncResult> {
  const existing = await fetchExistingIdMap(client);

  // Partition into inserts (new event_id, no PK) and updates (existing → carry
  // the PK). Kept separate so PostgREST sees a consistent column shape per
  // request and never receives a null identity column. synced_at on every row.
  const toInsert: Record<string, unknown>[] = [];
  const toUpdate: Record<string, unknown>[] = [];
  for (const r of records) {
    const id = existing.get(r.event_id);
    if (id !== undefined) toUpdate.push({ ...r, id, synced_at: nowIso });
    else toInsert.push({ ...r, synced_at: nowIso });
  }

  let upserted = 0;
  for (const batch of chunk(toInsert, BATCH)) {
    const { error } = await client.from(TABLE).insert(batch);
    if (error) throw new Error(`insert: ${error.message}`);
    upserted += batch.length;
  }
  for (const batch of chunk(toUpdate, BATCH)) {
    const { error } = await client.from(TABLE).upsert(batch); // conflict = PK (id)
    if (error) throw new Error(`upsert: ${error.message}`);
    upserted += batch.length;
  }

  // Soft-delete: existing event_ids not present in this sync run → inactive.
  const incoming = new Set(records.map((r) => r.event_id));
  const softDeletedIds: string[] = [];
  for (const eventId of Array.from(existing.keys())) {
    if (!incoming.has(eventId)) softDeletedIds.push(eventId);
  }
  for (const batch of chunk(softDeletedIds, BATCH)) {
    const { error } = await client
      .from(TABLE)
      .update({ status: "inactive", synced_at: nowIso })
      .in("event_id", batch);
    if (error) throw new Error(`soft-delete: ${error.message}`);
  }

  return { upserted, softDeletedIds };
}
