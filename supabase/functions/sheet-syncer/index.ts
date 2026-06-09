/**
 * sheet-syncer — Supabase Edge Function (Deno).
 *
 * Pulls the campaign-ledger Google Sheet "database" tab once per hour (cron)
 * and upserts it into dca_campaign_ledger; rows missing from the sheet are
 * soft-deleted (status='inactive'). The sheet is the source of truth — this
 * function NEVER writes back to it.
 *
 * v1 auth: the sheet is link-shared ("Anyone with link can view"), so we fetch
 * the public CSV export directly — no credentials needed. This is a documented
 * v1 trade-off; Phase 2 will harden to the Sheets API + a service account.
 * (Note: src/lib/bigquery.ts still uses the BQ service account — unaffected.)
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the platform.
 *
 * Deploy + schedule:
 *   supabase functions deploy sheet-syncer
 *   psql ... < supabase/functions/sheet-syncer/cron.sql   (hourly pg_cron)
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { transformSheet } from "../_shared/ledger-transform.ts";
import { syncLedger, type SupabaseLike } from "../_shared/ledger-sync.ts";

const SHEET_ID = "1zQnQudbjsUhCSZwSaOW9w7AO1-YX-7YL1xmessJGQew";
// "database" tab is gid=0.
const CSV_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

/** Minimal CSV parser (handles quoted fields, escaped quotes, embedded newlines). */
function parseCSV(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

Deno.serve(async (_req: Request) => {
  try {
    const res = await fetch(CSV_URL);
    if (!res.ok) throw new Error("CSV fetch failed: " + res.status);
    const values = parseCSV(await res.text());
    const t = transformSheet(values);

    const client = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    ) as unknown as SupabaseLike;

    const result = await syncLedger(client, t.records);

    const summary = {
      ok: true,
      synced: result.upserted,
      skipped_empty_event_id: t.skippedEmpty,
      duplicates_collapsed: t.dupCount,
      soft_deleted: result.softDeletedIds,
      status_unknown_count: t.statusLog.length,
    };
    console.log("sheet-syncer:", JSON.stringify(summary));
    return new Response(JSON.stringify(summary), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("sheet-syncer error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
