/**
 * T6 Step 3 smoke — runs the REAL shared transform + sync against
 * dca_campaign_ledger.
 *
 * Fetch transport: the public CSV export (the sheet is not yet shared with the
 * service account). The Edge Function uses the Sheets API instead — but the
 * transform (transformSheet) and the write path (syncLedger) under test here
 * are the exact same shared modules, so this validates the sync logic and
 * populates the table. Re-verify via the Sheets-API path after the sheet is
 * shared with the SA + Sheets API enabled.
 */
import { loadEnvConfig } from "@next/env";
import { getSupabase } from "../lib/supabase";
import { transformSheet } from "../supabase/functions/_shared/ledger-transform.ts";
import { syncLedger, type SupabaseLike } from "../supabase/functions/_shared/ledger-sync.ts";

const SHEET = "1zQnQudbjsUhCSZwSaOW9w7AO1-YX-7YL1xmessJGQew";
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET}/gviz/tq?tqx=out:csv&sheet=database`;

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

async function main() {
  loadEnvConfig(process.cwd());

  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error("CSV fetch failed: " + res.status);
  const values = parseCSV(await res.text());

  const t = transformSheet(values);
  const sb = getSupabase() as unknown as SupabaseLike;
  const result = await syncLedger(sb, t.records);

  console.log("================ SYNC OUTPUT ================");
  console.log(`Synced: ${result.upserted} rows upserted`);
  console.log(`Skipped: ${t.skippedEmpty} empty event_id rows`);
  console.log(`Duplicates collapsed: ${t.dupCount} event_ids` +
    (t.dupIds.length ? ` ${JSON.stringify(t.dupIds.slice(0, 30))}${t.dupIds.length > 30 ? " …" : ""}` : ""));
  console.log(`Soft-deleted (no longer in sheet): ${JSON.stringify(result.softDeletedIds)}`);
  console.log(`Status normalization log (${t.statusLog.length} → 'unknown'):`);
  for (const e of t.statusLog) {
    console.log(`   ${e.event_id} → "${e.raw}" → ${e.normalized}`);
  }

  // 5 sample rows back from the table
  const { data: sample } = await sb
    .from("dca_campaign_ledger")
    .select("event_id, event_name, budget_aed, channels, review_slot, status, country, event_category, synced_at")
    .order("synced_at", { ascending: false })
    .limit(5);
  console.log("\nSample 5 rows from dca_campaign_ledger:");
  console.dir(sample, { depth: null });
}

main().catch((e) => {
  console.error("T6_ERROR " + (e?.message ?? String(e)));
  process.exit(1);
});
