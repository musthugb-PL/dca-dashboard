"use client";

import { useEffect, useState } from "react";
import ThemeToggle from "@/app/components/ThemeToggle";
import DecisionCard from "@/app/components/DecisionCard";
import type { ReviewCardsResult } from "@/src/lib/data/dashboard";
import {
  slotForDate,
  slotDayLabel,
  mostRecentSlot,
  reviewWindow,
  type Slot,
} from "@/src/lib/slot";

const TTL_MS = 60 * 60 * 1000; // 1 hour
const SLOT_PILLS: ReadonlyArray<[Slot, string]> = [
  [1, "Mon"],
  [2, "Wed"],
  [3, "Fri"],
];

function windowDates() {
  const { dateFrom, dateTo } = reviewWindow(new Date());
  return { from: dateFrom, to: dateTo };
}

function cacheKey(slot: Slot, from: string, to: string) {
  return `optplus:cards:${slot}:${from}:${to}`;
}

function readCache(slot: Slot, from: string, to: string): ReviewCardsResult | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(slot, from, to));
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw) as { ts: number; data: ReviewCardsResult };
    if (Date.now() - ts > TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(slot: Slot, from: string, to: string, data: ReviewCardsResult) {
  try {
    sessionStorage.setItem(cacheKey(slot, from, to), JSON.stringify({ ts: Date.now(), data }));
  } catch {
    /* sessionStorage full / unavailable — fetch will just re-run */
  }
}

export default function DashboardPage() {
  const [slot, setSlot] = useState<Slot | null>(null);
  const [data, setData] = useState<ReviewCardsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Resolve the initial slot once, on mount (avoids SSR/CSR mismatch).
  useEffect(() => {
    const url = new URLSearchParams(window.location.search).get("slot");
    const initial =
      url && ["1", "2", "3"].includes(url)
        ? (Number(url) as Slot)
        : (slotForDate(new Date()) ?? mostRecentSlot(new Date()));
    setSlot(initial);
  }, []);

  // Load whenever the selected slot changes (cache-first).
  useEffect(() => {
    if (slot === null) return;
    const { from, to } = windowDates();
    const cached = readCache(slot, from, to);
    if (cached) {
      setData(cached);
      setLoading(false);
      setErr(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/review-cards?slot=${slot}`)
      .then((r) => r.json())
      .then((json: ReviewCardsResult & { error?: string }) => {
        if (cancelled) return;
        if (json.error) {
          setErr(json.error);
          setData(null);
        } else {
          writeCache(slot, from, to, json);
          setData(json);
          setErr(null);
        }
      })
      .catch((e) => !cancelled && setErr(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [slot]);

  function selectSlot(s: Slot) {
    if (s === slot) return;
    const url = new URL(window.location.href);
    url.searchParams.set("slot", String(s));
    window.history.replaceState(null, "", url);
    setSlot(s);
  }

  const todaySlot = typeof window !== "undefined" ? slotForDate(new Date()) : null;
  const dayLabel = slot ? slotDayLabel(slot) : "";
  const banner =
    slot === null || slot === todaySlot
      ? null
      : todaySlot === null
        ? `Off-day preview — today isn’t a review day. Showing Slot ${slot} (${dayLabel}), the most recent review.`
        : `Previewing Slot ${slot} (${dayLabel}).`;

  return (
    <main className="pl-app">
      <div className="dca-page">
        <header className="dca-header">
          <div className="dca-header-meta">
            <h1 className="t-title-xl">Optimization PLUS</h1>
            <span className="dca-slot t-body-sm-short">
              {slot ? `Slot ${slot} · ${dayLabel} review` : "Loading…"}
            </span>
            <span className="dca-count t-caption">
              {data ? `${data.counts.eligible} campaigns · 7 days+ active · status running` : " "}
            </span>
          </div>
          <ThemeToggle />
        </header>

        {/* Slot selector */}
        <div className="dca-toolbar" style={{ marginBottom: "var(--spacing-16)" }}>
          {SLOT_PILLS.map(([n, day]) => (
            <button
              key={n}
              type="button"
              className={`pl-tag${slot === n ? " sel" : ""}`}
              aria-current={slot === n ? "true" : undefined}
              onClick={() => selectSlot(n)}
            >
              Slot {n} · {day}
            </button>
          ))}
        </div>

        {banner && (
          <div className="pl-card-body dca-banner" style={{ marginBottom: "var(--spacing-16)" }}>
            <p className="t-caption" style={{ margin: 0 }}>{banner}</p>
          </div>
        )}

        {/* Filter bar — static for now (wiring deferred) */}
        <div className="dca-toolbar">
          <button type="button" className="pl-tag sel">All</button>
          <button type="button" className="pl-tag">Red flags</button>
          <button type="button" className="pl-tag">Clean</button>
          <label className="pl-input pl-input--m dca-toolbar-search">
            <input className="pl-input-field" placeholder="Search campaigns…" disabled />
          </label>
        </div>

        {loading ? (
          <div className="pl-card pl-card-elevated pl-card-padded dca-loading">
            <p className="t-body-base">Loading slot {slot}…</p>
          </div>
        ) : err ? (
          <div className="pl-card pl-card-elevated pl-card-padded dca-empty">
            <p className="t-body-base">Could not load campaigns: {err}</p>
          </div>
        ) : data && data.cards.length > 0 ? (
          <div className="dca-cards">
            {data.cards.map((c) => (
              <DecisionCard key={c.row.event_id} card={c} />
            ))}
          </div>
        ) : data ? (
          <div className="pl-card pl-card-elevated pl-card-padded dca-empty">
            <p className="t-body-base">
              No campaigns to review. Slot {slot} ({dayLabel}) had {data.counts.totalInSlot} total
              campaigns; {data.counts.running} running and {data.counts.eligible} running &amp; 7+
              days old.
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
