/**
 * Source B weekly-notes transform (PURE, no I/O).
 *
 * Each "Week N - Notes" tab has headers:
 *   event name | impressions | clicks | spend AED | tickets sold | total revenue AED |
 *   ROAS | CPM | CPC | CTR | CPA | Social | Google | Creatives | Other channels
 *
 * We keep ONLY the notes columns (Social/Google/Creatives/Other channels) plus the
 * event name, keyed by (week_label, event_name). Metrics live in BQ already.
 *
 * Rules: skip empty event names and the GA4 "(not set)" placeholder (logged);
 * last-row-wins on duplicate event names within a tab.
 */

export type WeeklyNote = {
  week_label: string;
  event_name: string;
  social_notes: string | null;
  google_notes: string | null;
  creative_notes: string | null;
  other_notes: string | null;
};

export type WeeklyTransformResult = {
  records: WeeklyNote[];
  skipped: number;
  dupCount: number;
  warnings: string[];
};

/** "Week 1 - notes" → "Week 1"; "Week25 - Notes" → "Week25"; "Week 3 Notes" → "Week 3". */
export function weekLabelFromTab(tab: string): string {
  return tab.replace(/\s*-?\s*[Nn]otes\s*$/, "").trim();
}

function headerIndex(headers: unknown[], name: string): number {
  return headers.findIndex(
    (h) => String(h ?? "").trim().toLowerCase() === name.toLowerCase(),
  );
}

function cell(row: unknown[], idx: number): string | null {
  if (idx < 0) return null;
  const v = String(row[idx] ?? "").trim();
  return v.length ? v : null;
}

/** Transform one Notes tab's matrix (row 0 = header) into WeeklyNote records. */
export function transformNotesTab(tab: string, rows: unknown[][]): WeeklyTransformResult {
  const week_label = weekLabelFromTab(tab);
  const headers = rows[0] ?? [];
  const idx = {
    name: headerIndex(headers, "event name"),
    social: headerIndex(headers, "Social"),
    google: headerIndex(headers, "Google"),
    creatives: headerIndex(headers, "Creatives"),
    other: headerIndex(headers, "Other channels"),
  };

  let skipped = 0;
  const warnings: string[] = [];
  const byName = new Map<string, WeeklyNote>();
  const seen = new Set<string>();
  const dupNames = new Set<string>();

  for (const row of rows.slice(1)) {
    const event_name = cell(row, idx.name);
    if (!event_name) {
      skipped++;
      continue;
    }
    if (event_name.toLowerCase() === "(not set)") {
      skipped++;
      warnings.push(`${week_label}: skipped "(not set)" row`);
      continue;
    }
    if (seen.has(event_name)) dupNames.add(event_name);
    seen.add(event_name);

    byName.set(event_name, {
      week_label,
      event_name,
      social_notes: cell(row, idx.social),
      google_notes: cell(row, idx.google),
      creative_notes: cell(row, idx.creatives),
      other_notes: cell(row, idx.other),
    });
  }

  return {
    records: Array.from(byName.values()),
    skipped,
    dupCount: dupNames.size,
    warnings,
  };
}
