/**
 * Source B weekly-notes sync (runtime-agnostic; takes a Supabase client).
 *
 * Writes ONLY dca_source_b_weekly_notes. Constraint-independent upsert keyed on
 * (week_label, event_name): look up existing id by that pair, attach it (→ update),
 * else insert. event_id is resolved by matching LOWER(TRIM(event_name)) against
 * dca_campaign_ledger — only when the name maps to exactly one event_id.
 *
 * No soft-delete: dca_source_b_weekly_notes has no status column and weekly notes
 * are append-only history, so rows are never inactivated.
 */

import type { WeeklyNote } from "./source-b-transform";

export interface SupabaseLike {
  from(table: string): any;
}

const TABLE = "dca_source_b_weekly_notes";
const BATCH = 500;
const PAGE = 1000;

export type WeeklySyncResult = {
  upserted: number;
  resolved: number; // rows where event_id was matched
  unresolved: number;
};

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();

/** ledger event_name(lower/trim) → set of event_ids (ambiguous names left unresolved). */
async function ledgerNameMap(client: SupabaseLike): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  for (let off = 0; ; off += PAGE) {
    const { data, error } = await client
      .from("dca_campaign_ledger")
      .select("event_id, event_name")
      .range(off, off + PAGE - 1);
    if (error) throw new Error("ledger map: " + error.message);
    const rows = (data ?? []) as { event_id: string; event_name: string }[];
    for (const r of rows) {
      if (!r.event_name || !r.event_id) continue;
      const k = norm(r.event_name);
      if (!map.has(k)) map.set(k, new Set());
      map.get(k)!.add(String(r.event_id));
    }
    if (rows.length < PAGE) break;
  }
  return map;
}

/** Existing (week_label|event_name) → row id, paginated. */
async function existingKeyMap(client: SupabaseLike): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (let off = 0; ; off += PAGE) {
    const { data, error } = await client
      .from(TABLE)
      .select("id, week_label, event_name")
      .range(off, off + PAGE - 1);
    if (error) throw new Error("existing keys: " + error.message);
    const rows = (data ?? []) as { id: number; week_label: string; event_name: string }[];
    for (const r of rows) map.set(`${r.week_label}||${r.event_name}`, r.id);
    if (rows.length < PAGE) break;
  }
  return map;
}

export async function syncWeeklyNotes(
  client: SupabaseLike,
  records: WeeklyNote[],
  nowIso: string = new Date().toISOString(),
): Promise<WeeklySyncResult> {
  const [nameMap, existing] = await Promise.all([
    ledgerNameMap(client),
    existingKeyMap(client),
  ]);

  let resolved = 0;
  const toInsert: Record<string, unknown>[] = [];
  const toUpdate: Record<string, unknown>[] = [];

  for (const r of records) {
    const ids = nameMap.get(norm(r.event_name));
    const event_id = ids && ids.size === 1 ? Array.from(ids)[0] : null;
    if (event_id) resolved++;

    const base = { ...r, event_id, synced_at: nowIso };
    const id = existing.get(`${r.week_label}||${r.event_name}`);
    if (id !== undefined) toUpdate.push({ ...base, id });
    else toInsert.push(base);
  }

  let upserted = 0;
  for (const b of chunk(toInsert, BATCH)) {
    const { error } = await client.from(TABLE).insert(b);
    if (error) throw new Error("insert: " + error.message);
    upserted += b.length;
  }
  for (const b of chunk(toUpdate, BATCH)) {
    const { error } = await client.from(TABLE).upsert(b); // conflict = PK id
    if (error) throw new Error("upsert: " + error.message);
    upserted += b.length;
  }

  return { upserted, resolved, unresolved: records.length - resolved };
}
