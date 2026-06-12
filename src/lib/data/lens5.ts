/**
 * Lens 5 (Last Week) context assembly — P2.2 Addition 2.
 *
 * Reads ALL FOUR past-decision sources and unions them, with robust matching
 * because `dca_source_b_weekly_notes.event_id` is almost always NULL:
 *   1. dca_decisions             — exact event_id
 *   2. dca_source_b_weekly_notes — event_id OR fuzzy name-token match
 *   3. dca_source_b_notes        — event_id OR fuzzy name-token match
 *   4. dca_v_optimisation_notes  — exact event_id
 *
 * Name-token match: split the current event name into 2+ char non-stopword
 * tokens; a stored note matches if ANY token appears in its event_name. Catches
 * "Russel Peters" vs "Russell Peters" vs "Live Nation Presents Russell Peters".
 *
 * If nothing matches, returns an empty set — the Lens 5 prompt then states that
 * honestly (Sacred Rule #11), never invents history.
 */

import { getSupabase } from "@/lib/supabase";
import type { PastDecisions, PastDecisionItem } from "./events";

// Stopwords: country/edition/venue/generic words that would over-match if used
// as a sole matching token. Artist/show tokens survive and stay distinctive.
const STOPWORDS = new Set([
  "uae", "ksa", "qa", "qat", "bh", "om", "egy", "sa", "ae", "cc", "ad",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  "live", "at", "in", "the", "presents", "presented", "by", "and", "with", "of",
  "concert", "show", "tour", "night", "nights", "festival", "fest", "edition",
  "dubai", "abu", "dhabi", "sharjah", "riyadh", "jeddah", "doha", "manama", "muscat",
  "opera", "arena", "etihad", "coca", "cola", "hall", "theatre", "theater", "stadium",
  "park", "club", "lounge", "centre", "center", "2023", "2024", "2025", "2026", "2027",
]);

/** 2+ char non-stopword, non-pure-digit tokens of an event name (lowercased). */
function nameTokens(name: string): string[] {
  return Array.from(
    new Set(
      (name || "")
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
    ),
  );
}

function nameMatches(tokens: string[], storedName: string | null): boolean {
  if (!storedName) return false;
  const s = storedName.toLowerCase();
  return tokens.some((t) => s.includes(t));
}

const trim = (s: unknown, n = 300): string =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Build the PostgREST `or=` filter for event_id OR any name token (ilike). */
function orFilter(eventId: number, tokens: string[]): string {
  const parts = [`event_id.eq.${eventId}`, ...tokens.map((t) => `event_name.ilike.*${t}*`)];
  return parts.join(",");
}

export async function getPastDecisionsContext(
  eventId: number,
  eventName: string,
  perSourceLimit = 15,
): Promise<PastDecisions> {
  const sb = getSupabase();
  const eid = String(eventId);
  const tokens = nameTokens(eventName);
  const items: PastDecisionItem[] = [];

  // 1. dca_decisions — exact event_id (no event_name column).
  try {
    const { data } = await sb
      .from("dca_decisions")
      .select("review_date,final_action,reasoning,expected_outcome,actual_outcome")
      .eq("event_id", eid)
      .order("review_date", { ascending: false })
      .limit(perSourceLimit);
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const parts = [trim(r.reasoning)];
      if (r.expected_outcome) parts.push("predicted: " + trim(r.expected_outcome, 160));
      if (r.actual_outcome) parts.push("actual: " + trim(r.actual_outcome, 160));
      items.push({
        source: "decisions",
        matched_by: "event_id",
        when: r.review_date ? String(r.review_date) : null,
        event_name: null,
        action: r.final_action ? String(r.final_action) : null,
        text: parts.filter(Boolean).join(" | "),
      });
    }
  } catch {
    /* best-effort per source */
  }

  // 2. dca_source_b_weekly_notes — event_id OR fuzzy name (event_id usually null).
  try {
    let q = sb
      .from("dca_source_b_weekly_notes")
      .select("week_label,event_name,event_id,social_notes,google_notes,creative_notes,other_notes")
      .limit(perSourceLimit * 2);
    q = tokens.length ? q.or(orFilter(eventId, tokens)) : q.eq("event_id", eid);
    const { data } = await q;
    const seen = new Set<string>();
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const byId = String(r.event_id ?? "") === eid;
      if (!byId && !nameMatches(tokens, r.event_name as string | null)) continue;
      const notes = [
        r.social_notes && "social: " + trim(r.social_notes),
        r.google_notes && "google: " + trim(r.google_notes),
        r.creative_notes && "creative: " + trim(r.creative_notes),
        r.other_notes && "other: " + trim(r.other_notes),
      ].filter(Boolean) as string[];
      if (!notes.length) continue; // skip empty note rows
      const text = notes.join(" | ");
      const key = `${r.event_name}|${r.week_label}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        source: "weekly_notes",
        matched_by: byId ? "event_id" : "name",
        when: r.week_label ? String(r.week_label) : null,
        event_name: r.event_name ? String(r.event_name) : null,
        action: null,
        text,
      });
      if (items.filter((i) => i.source === "weekly_notes").length >= perSourceLimit) break;
    }
  } catch {
    /* best-effort */
  }

  // 3. dca_source_b_notes (55-row master) — event_id OR fuzzy name.
  try {
    let q = sb
      .from("dca_source_b_notes")
      .select("week_of,event_id,event_name,action_taken,reasoning,prediction,actual_outcome")
      .limit(perSourceLimit * 2);
    q = tokens.length ? q.or(orFilter(eventId, tokens)) : q.eq("event_id", eid);
    const { data } = await q;
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const byId = String(r.event_id ?? "") === eid;
      if (!byId && !nameMatches(tokens, r.event_name as string | null)) continue;
      const parts = [trim(r.reasoning)];
      if (r.prediction) parts.push("predicted: " + trim(r.prediction, 160));
      if (r.actual_outcome) parts.push("actual: " + trim(r.actual_outcome, 160));
      items.push({
        source: "source_b_notes",
        matched_by: byId ? "event_id" : "name",
        when: r.week_of ? String(r.week_of) : null,
        event_name: r.event_name ? String(r.event_name) : null,
        action: r.action_taken ? String(r.action_taken) : null,
        text: parts.filter(Boolean).join(" | "),
      });
    }
  } catch {
    /* best-effort */
  }

  // 4. dca_v_optimisation_notes — exact event_id (existing dashboard's notes).
  try {
    const { data } = await sb
      .from("dca_v_optimisation_notes")
      .select("week_of,author,content")
      .eq("event_id", eid)
      .order("week_of", { ascending: false })
      .limit(perSourceLimit);
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      if (!r.content) continue;
      items.push({
        source: "optimisation_notes",
        matched_by: "event_id",
        when: r.week_of ? String(r.week_of) : null,
        event_name: null,
        action: null,
        text: trim(r.content),
      });
    }
  } catch {
    /* best-effort */
  }

  return { items, count: items.length };
}
