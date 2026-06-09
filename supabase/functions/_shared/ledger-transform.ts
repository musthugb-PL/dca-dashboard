/**
 * Campaign-ledger sheet → dca_campaign_ledger transform (PURE, no I/O).
 *
 * Shared by the sheet-syncer Edge Function (Deno) and the Node smoke test.
 * Operates on a values matrix (string[][]) where row 0 is the header row —
 * which is exactly what both the Google Sheets API (`values`) and a parsed
 * CSV export produce. No external imports so it runs unchanged in both
 * runtimes.
 *
 * Decisions locked with the user:
 *  - Empty Event ID rows  → SKIP (counted).
 *  - Duplicate Event IDs  → LAST-ROW-WINS (counted).
 *  - Status              → trim + lowercase + allowlist map; anything else
 *                          → 'unknown' (raw value logged for sheet fixes).
 *  - Review Slot         → verbatim ('1' / '2' / '3' / null).
 */

export type LedgerRecord = {
  event_id: string; // primary key = first id in the cell (backward-compat)
  event_ids: string[]; // full list — multi-id landing pages / festivals
  event_name: string;
  event_link: string;
  budget_aed: number | null;
  channels: string[];
  event_ends: string | null;
  primary_campaign_manager: string;
  review_slot: string | null;
  country: string;
  status: string;
  report_v5_link: string | null;
  campaign_start_date: string | null;
  campaign_end_date: string | null;
  org_name: string;
  org_email: string;
  responsible_person: string;
  event_category: string;
};

export type StatusLogEntry = { event_id: string; raw: string; normalized: string };

export type TransformResult = {
  records: LedgerRecord[];
  skippedEmpty: number;
  dupCount: number;
  dupIds: string[];
  statusLog: StatusLogEntry[];
};

/**
 * Status allowlist as [prefix, canonical] pairs. After trim + toLowerCase, the
 * raw value is matched by startsWith() — so any future variant of an allowlist
 * value normalises correctly (e.g. "Ended - event sold out" → 'ended',
 * "running - high priority" → 'running'). Spelling variants that aren't a
 * prefix of the canonical ('sold out', 'postpone') are listed explicitly.
 * Anything matching no prefix → 'unknown' (logged for sheet fixes).
 */
const STATUS_PREFIXES: ReadonlyArray<[string, string]> = [
  ["ended", "ended"],
  ["stopped", "stopped"],
  ["running", "running"],
  ["cancelled", "cancelled"],
  ["paused", "paused"],
  ["postponed", "postponed"],
  ["postpone", "postponed"],
  ["soldout", "soldout"],
  ["sold out", "soldout"],
];

export function normalizeStatus(raw: string): { normalized: string; unknown: boolean } {
  const t = (raw ?? "").trim().toLowerCase();
  if (t) {
    for (const [prefix, canonical] of STATUS_PREFIXES) {
      if (t.startsWith(prefix)) return { normalized: canonical, unknown: false };
    }
  }
  return { normalized: "unknown", unknown: true };
}

/** "10,000.00" → 10000.00 ; ""/garbage → null. */
export function parseBudget(raw: string): number | null {
  const cleaned = (raw ?? "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Accepts DD/MM/YYYY, Google "Date(y,m,d)" (0-based month), or ISO → YYYY-MM-DD. */
export function parseDate(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s || s.toLowerCase() === "null") return null;

  const gv = s.match(/^Date\((\d+),(\d+),(\d+)\)$/);
  if (gv) {
    const y = Number(gv[1]);
    const m = Number(gv[2]) + 1; // 0-based
    const d = Number(gv[3]);
    return iso(y, m, d);
  }

  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    return iso(Number(dmy[3]), Number(dmy[2]), Number(dmy[1])); // DD/MM/YYYY
  }

  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  return null;
}

function iso(y: number, m: number, d: number): string | null {
  if (!y || !m || !d || m > 12 || d > 31) return null;
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

/** "Facebook, Google" → ['Facebook','Google']. */
export function splitChannels(raw: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/** Trimmed cell, treating Google's literal 'null' export string as empty. */
function cell(row: string[], idx: number): string {
  if (idx < 0) return "";
  const v = (row[idx] ?? "").trim();
  return v.toLowerCase() === "null" ? "" : v;
}

function headerIndex(headers: string[], name: string): number {
  return headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}

export function transformSheet(values: string[][]): TransformResult {
  const headers = values[0] ?? [];
  const dataRows = values.slice(1).filter((r) => r.some((c) => c && c.trim()));

  const idx = {
    event_id: headerIndex(headers, "Event ID"),
    event_name: headerIndex(headers, "event name"),
    event_link: headerIndex(headers, "Link"),
    budget: headerIndex(headers, "Budget (AED)"),
    channels: headerIndex(headers, "Channels"),
    event_ends: headerIndex(headers, "Event ends"),
    manager: headerIndex(headers, "Primary Campaign Manager"),
    slot: headerIndex(headers, "Review Slot"),
    country: headerIndex(headers, "Country"),
    status: headerIndex(headers, "Status"),
    report_v5: headerIndex(headers, "New Report Format (v5)"),
    org_name: headerIndex(headers, "ORG name"),
    camp_start: headerIndex(headers, "Campaign Start Date"),
    camp_end: headerIndex(headers, "Campaign End Date"),
    org_email: headerIndex(headers, "ORG email"),
    responsible: headerIndex(headers, "Responsible person"),
    category: headerIndex(headers, "Event Category"),
  };

  let skippedEmpty = 0;
  const statusLog: StatusLogEntry[] = [];
  const byId = new Map<string, LedgerRecord>();
  const seen = new Set<string>();
  const dupIds = new Set<string>();

  for (const row of dataRows) {
    // Multi-id landing pages store ids pipe-delimited, e.g. "90185|89712".
    // Split, trim, drop empty/'null' pieces. Empty result → genuinely empty row.
    const rawId = idx.event_id >= 0 ? (row[idx.event_id] ?? "") : "";
    const ids = rawId
      .split("|")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.toLowerCase() !== "null");
    if (ids.length === 0) {
      skippedEmpty++;
      continue;
    }
    const event_id = ids[0]; // primary key

    if (seen.has(event_id)) dupIds.add(event_id);
    seen.add(event_id);

    const rawStatus = idx.status >= 0 ? (row[idx.status] ?? "") : "";
    const { normalized, unknown } = normalizeStatus(rawStatus);
    if (unknown) statusLog.push({ event_id, raw: rawStatus.trim(), normalized });

    const slotRaw = cell(row, idx.slot);

    byId.set(event_id, {
      event_id,
      event_ids: ids,
      event_name: cell(row, idx.event_name),
      event_link: cell(row, idx.event_link),
      budget_aed: parseBudget(cell(row, idx.budget)),
      channels: splitChannels(cell(row, idx.channels)),
      event_ends: parseDate(cell(row, idx.event_ends)),
      primary_campaign_manager: cell(row, idx.manager),
      review_slot: slotRaw || null,
      country: cell(row, idx.country),
      status: normalized,
      report_v5_link: cell(row, idx.report_v5) || null,
      campaign_start_date: parseDate(cell(row, idx.camp_start)),
      campaign_end_date: parseDate(cell(row, idx.camp_end)),
      org_name: cell(row, idx.org_name),
      org_email: cell(row, idx.org_email),
      responsible_person: cell(row, idx.responsible),
      event_category: cell(row, idx.category),
    });
  }

  return {
    records: Array.from(byId.values()),
    skippedEmpty,
    dupCount: dupIds.size,
    dupIds: Array.from(dupIds),
    statusLog,
  };
}
