"use client";

/**
 * B5: "Re-run AI brain" button on a campaign card. POSTs to /api/run-brain,
 * shows a running state (~40s ETA), then clears the slot cache + reloads so the
 * card picks up the fresh persisted analysis.
 */
import { useState } from "react";

export default function RunBrainButton({ eventId }: { eventId: string }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function run() {
    setState("running");
    setMsg("");
    try {
      const res = await fetch("/api/run-brain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: eventId }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setState("done");
      setMsg(`${j.action} · ${j.seconds}s`);
      // Drop the dashboard's cached slot data so the reload re-fetches.
      try {
        Object.keys(sessionStorage)
          .filter((k) => k.startsWith("optplus:cards:"))
          .forEach((k) => sessionStorage.removeItem(k));
      } catch {
        /* sessionStorage unavailable — reload still re-fetches */
      }
      setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setState("error");
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  const label =
    state === "running" ? "⚡ Running… (~40s)"
    : state === "done" ? `✓ ${msg}`
    : state === "error" ? "⚠ Failed — retry"
    : "⚡ Re-run AI brain";

  return (
    <button
      type="button"
      className="pl-btn pl-btn-ghost pl-btn-s dca-runbrain"
      onClick={run}
      disabled={state === "running"}
      title={state === "error" ? msg : "Re-run the AI brain for this campaign (~40s, costs ~$0.04)"}
    >
      {label}
    </button>
  );
}
