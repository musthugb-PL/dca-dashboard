import https from "node:https";
import * as XLSX from "xlsx";
import { getSupabase } from "@/lib/supabase";
import { transformNotesTab, type WeeklyNote } from "@/supabase/functions/_shared/source-b-transform";
import { syncWeeklyNotes, type SupabaseLike } from "@/supabase/functions/_shared/source-b-sync";

// Node runtime — the 41 MB XLSX parse exceeds Deno edge limits (WORKER_RESOURCE_LIMIT).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 41 MB download + parse; needs Vercel Pro for >60s

const SHEET_ID = "1iGYFYHeJ3km7HdaH4sl9eoDHehefcjvBC4ygEOHkrms";
const XLSX_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;
const NOTES_RE = /^Week ?\d+( v\d+)? ?-? ?[Nn]otes$/;

/**
 * Download the 41 MB XLSX via node:https (undici's fetch aborts large bodies
 * with "terminated"). Follows Google's export redirect to googleusercontent.
 */
function downloadXlsx(url: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects < 5) {
        res.resume(); // drain
        resolve(downloadXlsx(new URL(res.headers.location, url).toString(), redirects + 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error("XLSX fetch failed: " + status));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(180_000, () => req.destroy(new Error("XLSX download timeout")));
  });
}

async function run() {
  const buf = await downloadXlsx(XLSX_URL);

  const names = XLSX.read(buf, { type: "buffer", bookSheets: true }).SheetNames;
  const noteTabs = names.filter((n) => NOTES_RE.test(n));
  const wb = XLSX.read(buf, { type: "buffer", sheets: noteTabs });

  const records: WeeklyNote[] = [];
  let skipped = 0;
  for (const tab of noteTabs) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[tab], {
      header: 1,
      blankrows: false,
    });
    const t = transformNotesTab(tab, rows as unknown[][]);
    records.push(...t.records);
    skipped += t.skipped;
  }

  const result = await syncWeeklyNotes(getSupabase() as unknown as SupabaseLike, records);
  const summary = {
    ok: true,
    tabs: noteTabs.length,
    synced: result.upserted,
    skipped,
    resolved_event_id: result.resolved,
    unresolved_event_id: result.unresolved,
  };
  console.log("[source-b-weekly-syncer]", JSON.stringify(summary));
  return summary;
}

async function handle() {
  try {
    return Response.json(await run());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[source-b-weekly-syncer] error:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Vercel cron invokes via GET; POST kept for manual triggers.
export const GET = handle;
export const POST = handle;
