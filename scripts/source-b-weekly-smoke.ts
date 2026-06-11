/**
 * Track A smoke — validates the Source B weekly-notes sync locally.
 * Reads the downloaded source-b.xlsx (the Edge Function fetches it live),
 * runs the same transform + sync, and reports counts.
 */
import fs from "node:fs";
import { loadEnvConfig } from "@next/env";
import * as XLSX from "xlsx";
import { getSupabase } from "../lib/supabase";
import { transformNotesTab, type WeeklyNote } from "../supabase/functions/_shared/source-b-transform.ts";
import { syncWeeklyNotes, type SupabaseLike } from "../supabase/functions/_shared/source-b-sync.ts";

const NOTES_RE = /^Week ?\d+( v\d+)? ?-? ?[Nn]otes$/;

async function main() {
  loadEnvConfig(process.cwd());
  const buf = fs.readFileSync("source-b.xlsx");

  const names = XLSX.read(buf, { type: "buffer", bookSheets: true }).SheetNames;
  const noteTabs = names.filter((n) => NOTES_RE.test(n));
  console.log(`Tabs found (Notes): ${noteTabs.length} of ${names.length} total`);

  const wb = XLSX.read(buf, { type: "buffer", sheets: noteTabs });
  const records: WeeklyNote[] = [];
  let skipped = 0;
  console.log("\nRows per tab (first 6):");
  noteTabs.forEach((tab, i) => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[tab], { header: 1, blankrows: false });
    const t = transformNotesTab(tab, rows as unknown[][]);
    records.push(...t.records);
    skipped += t.skipped;
    if (i < 6) console.log(`  "${tab}" → ${t.records.length} records (skipped ${t.skipped})`);
  });
  console.log(`\nTotal records: ${records.length} | total skipped: ${skipped}`);

  console.log("\n3 sample records:");
  records.slice(0, 3).forEach((r) => console.dir(r, { depth: null }));

  const sb = getSupabase() as unknown as SupabaseLike;
  const result = await syncWeeklyNotes(sb, records);

  console.log("\n================ SYNC OUTPUT ================");
  console.log(`Synced (upserted): ${result.upserted}`);
  console.log(`event_id resolved:  ${result.resolved}`);
  console.log(`event_id null:      ${result.unresolved}`);

  // sample resolved + unresolved rows from the table
  const realSb = getSupabase();
  const { data: resolvedRows } = await realSb
    .from("dca_source_b_weekly_notes")
    .select("week_label,event_name,event_id")
    .not("event_id", "is", null)
    .limit(3);
  console.log("\nSample rows WITH event_id:");
  console.dir(resolvedRows, { depth: null });
}

main().catch((e) => { console.error("SMOKE_ERROR " + (e?.message ?? e)); process.exit(1); });
