# Campaign Optimization Dashboard — Project Brief

**Single-read summary. Pick up here if continuing in a new session.**

---

## 1. Vision

Internal AI dashboard. ~100 active paid campaigns; ~33 surfaced per Mon/Wed/Fri session as decision cards. Each card walks ALL 6 lenses (Internal → Meta → Google → GA4 → Last Week → Market), suggests one of 6 actions (KILL / PAUSE / OPTIMIZE / SCALE / REMARKET / HOLD), waits for human approval. **Nothing auto-executes.** Monthly learning loops grow the AI's playbook from approved decisions.

**Must match the existing Marketing Insights Dashboard inch-by-inch on ad metrics + sales + funnel** so the team trusts both.

---

## 2. Status snapshot (as of last session)

| Phase | Status |
|---|---|
| 0 — Foundation (SOP, Data Map, framework, architecture) | ✅ Done |
| 1a — Lock all decisions, 6 lenses, alignment rules, sacred rules | ✅ Done |
| **1b — Wire** (Vercel + BQ + queries + Tier 1/2/3 + cap) | 🔨 In progress |
| 2 — AI brain + UI + learning loops + Strategy tab | ⏳ Next |

**Phase 1b sub-progress:**
- Next.js scaffold ✅
- `@google-cloud/bigquery` + `@supabase/supabase-js` installed ✅
- `.gitignore` hardened with targeted secret patterns ✅
- BQ service-account key in `.env.local` (gitignored) ✅
- `lib/bigquery.ts` helper written, auto-detects base64/raw JSON ✅
- BQ smoke query passed (49,081 orders for May 28 – Jun 4) ✅
- `src/lib/data/bq-event.ts` (T1) written — `getEventSales`, `getChannelPerformance`, `getFunnel` ✅
- T1 smoke against Russell Peters event 104963 / Jun 1-7 matches the Marketing Insights screenshot inch-by-inch ✅
- **T2 (Meta Tier 1/2/3 attribution)** in progress — waiting on Supabase service-role key in `.env.local`
- T3 (cap logic) pending
- T4 (event report orchestrator) pending
- T5 (full Russell Peters validation: target meta_tickets=13) pending

---

## 3. Stack

- **Frontend:** Next.js 14 (App Router) on Vercel (free tier)
- **Backend:** Supabase Edge Functions (cron) + service-role auth
- **Primary read warehouse:** Google BigQuery (read-only via service account)
- **Secondary warehouse:** Supabase project `kwftlkfvtglnugxsyjci`
- **AI gateway:** OpenRouter
- **Models:** Claude Haiku 4.5 (routine) · Claude Sonnet 4.6 (hard) · Perplexity Sonar (web) · DeepSeek R1 (monthly learning) · Gemini Flash (fallback)

---

## 4. Framework (locked)

**Three loops:** Watch → Diagnose → Act.

**6 Actions:** KILL · PAUSE · OPTIMIZE · SCALE · REMARKET · HOLD.

**6 Lenses (exact order, walked every time, never stop early):**
1. **Internal** — 3d vs prior 3d sales delta
2. **Meta** — 7d vs T-7, weighted score 0-100
3. **Google** — 7d vs T-7, weighted score 0-100
4. **GA4** — funnel + bounce + LP signals
5. **Last Week** — Source B history; opposite-direction prediction failure OR same-action loop within 14d
6. **Market** — external context, daily macro UAE scan + per-event artist scan

**Reference data priority** for every lens: own event history → top 5 direct analogs → affinity siblings currently running → cluster baseline (last resort).

---

## 5. Red Flags (the only trigger)

| Red Flag | Threshold |
|---|---|
| Marketing ticket share | < 15% |
| Meta CPA | > AED 150 OR > 1/10 ticket price (stricter wins) |
| Google CPA | Outside 5–25% of ticket price |
| CPA streak | Rising 3 days in a row |
| ROAS / Revenue WoW | Down WoW |
| CTR drop | > 20% (7d vs prev 7d) |

All campaigns included regardless of budget. New campaigns < 7 days = HOLD, no Red Flag.

---

## 6. Sacred Rules (never violate)

1. **No action ever executes without human click.**
2. **Approve button refuses to submit if expected-outcome field is empty.**
3. **Walk all 6 lenses every time.**
4. **Never touch original tables.** Code references only `dca_*` and `dca_v_*`.
5. **Forecast = use existing Event Sales Forecasting skill** (curve-based, 3 scenarios). Never linear.
6. **Cluster baselines = last resort.**
7. **Lens 1 first, Lens 6 last.**
8. **Event Category column on the campaign ledger is the cluster key.**
9. **Agency rule — no cross-event budget reallocation.** Platinumlist is an agency; each event funded by a different organizer (Live Nation, Shurooq, etc.). Budget reallocation allowed ONLY *within* a single event. Escalate to human if underperforming — never redirect across portfolio.
10. **Security — no secrets in code or docs.** All keys in Vercel env vars / `.env.local` (gitignored). `.gitignore` blocks `*service-account*.json`, `gcp-*.json`, `*-credentials*.json`, `*.key.json`. Never log secret values.

---

## 7. CRITICAL ALIGNMENT RULE — Marketing Insights Dashboard parity

Numbers in our dashboard MUST equal what the Marketing Insights Dashboard shows for the same event + same date.

| Metric | Source | NOT this |
|---|---|---|
| Spend / Impressions / Clicks / CTR / CPC (ALL platforms) | BQ `channels_3_campaign_level_llm` | `dca_v_meta_ads.spend_aed` / `dca_v_google_ads.spend_aed` |
| Meta tickets + revenue | Supabase `dream_facebook_custom_conversions` + Tier 1/2/3 + scaling + cap | Meta UTM purchase counts |
| Google / non-Meta tickets + revenue | BQ `channels_3_campaign_level_llm.total_quantity` + `total_revenue_aed` | `dca_v_google_ads.conversions` |
| Total sales / tickets sold / orders | BQ `completed_orders` | `dca_v_event_sales_daily` |
| Funnel | BQ `GA4_funnel_LP_table` | — |
| Manual campaign attachments | `dca_v_event_campaign_overrides` | — |
| Tracked-event allowlist | `dca_v_tracked_events` | — |

**Schema gotchas (caught during T1 build):**
- `completed_orders.id_event` is INT64 (not `event_id`); revenue column is `amount_aed`
- `channels_3_campaign_level_llm.event_id` is STRING
- `GA4_funnel_LP_table.event_id` is INT64
- Funnel stages: `users_on_lp → users_on_ticket_office → users_with_checkout → users_with_purchase`. There is NO `users_add_to_cart` column — `users_on_ticket_office` is the cart-equivalent stage

---

## 8. Meta Attribution (Tier 1/2/3 — exact spec)

**Tier 1 — Event-ID match (preferred):**
1. Regex `_(\d{4,7})_` extracts event_id from campaign name
2. Find CC labels containing event_id as standalone number (boundary check `(^|[^0-9])<id>([^0-9]|$)`)
3. Pick label with most firings if multiple qualify

**Tier 2 — Token-subset match (legacy fallback):**
1. Tokenize campaign name (lowercase, drop stopwords + pure digits). Stopwords: `uae, ksa, qa, bh, om, egy, cc, ad, sa, ae, jun, jul, aug, sep, oct, nov, dec, jan, feb, mar, apr, may, live, at, in, the, presents`
2. Tokenize each CC label the same way
3. Label "qualifies" if every label token is in campaign tokens
4. Pick qualifying label with most firings

**Tier 3 — Fallback:** Meta-pixel `purchases` count (UTM-based).

**Ticket scaling:**
```
meta_tickets = meta_cc_firings × avg_tickets_per_order
meta_revenue = meta_tickets × avg_ticket_price
```
(both averages from BQ `completed_orders` per event)

**Cap logic (per event per day):**
```
cap_ratio = MIN(1, total_tickets / NULLIF(raw_marketing_tickets, 0))
For each channel: capped_tickets = raw_tickets × cap_ratio
```

---

## 9. Database — owned tables (`dca_*`, 9 writeable)

`dca_decisions` · `dca_red_flag_events` · `dca_prompt_overrides` · `dca_cluster_baselines` · `dca_event_baselines` · `dca_source_a_cases` (120 rows imported) · `dca_source_b_notes` (55 rows imported) · `dca_proposed_rules` · `dca_campaign_ledger` (5 demo events)

## 10. Database — read-only views (`dca_v_*`, 19 views total)

Original 16: `dca_v_meta_ads`, `dca_v_meta_custom_conversions`, `dca_v_google_ads`, `dca_v_events`, `dca_v_event_sales_daily`, `dca_v_marketing_share`, `dca_v_event_sales_prior`, `dca_v_event_source_medium`, `dca_v_affinity`, `dca_v_similar_events`, `dca_v_competitor_prices`, `dca_v_competitor_events`, `dca_v_competitor_meta_ads`, `dca_v_competitor_google_ads`, `dca_v_ga4_pages`, `dca_v_ga4_paid_campaigns`.

Plus 3 added for Marketing Insights Dashboard alignment:
- `dca_v_event_campaign_overrides` (over `lnd_event_campaign_overrides`) — manual attachments
- `dca_v_tracked_events` (over `lnd_tracked_events`) — admin allowlist
- `dca_v_optimisation_notes` (over `lnd_optimisation_notes`) — existing dashboard's notes for Lens 5 cross-ref

---

## 11. Demo events in `dca_campaign_ledger`

| Event ID | Event | Slot | Category |
|---|---|---|---|
| 104166 | GameExpo 2026 | 1 | Gaming & ESports |
| 105338 | The Corrs at Etihad Arena | 2 | Popular Shows |
| 105779 | Atif Aslam Live in Abu Dhabi | 1 | Desi Events |
| 105964 | Omar Khairat Live in Abu Dhabi | 2 | Arabic + Classical |
| 105811 | Jalsat at the Cultural Foundation | 3 | Arabic Events |

Plus event **104963** (Russell Peters at Etihad Arena) — Marketing Insights screenshot reference for parity validation.

---

## 12. Environment variables

```
SUPABASE_URL=https://kwftlkfvtglnugxsyjci.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<from Supabase → Settings → API>
OPENROUTER_API_KEY=<from openrouter.ai>
GCP_BQ_SERVICE_ACCOUNT_JSON=<base64-encoded JSON, or raw JSON; helper auto-detects>
```

Status in `.env.local`:
- `SUPABASE_URL` ✅
- `GCP_BQ_SERVICE_ACCOUNT_JSON` ✅
- `OPENROUTER_API_KEY` ⏸ placeholder (not blocking T2-T5)
- `SUPABASE_SERVICE_ROLE_KEY` ⏸ placeholder (BLOCKS T2 — next paste needed)

---

## 13. Open work for next session

**Immediate:**
1. Paste Supabase service-role key into `.env.local` (unblocks T2)
2. Code mode finishes T2 (Meta Tier 1/2/3). Expected output: Russell Peters meta_tickets = 13.0
3. T3 — cap logic (`src/lib/data/cap.ts`)
4. T4 — event report orchestrator (`src/lib/data/events.ts`) merging T1+T2+T3
5. T5 — final Russell Peters validation; all numbers match the screenshot

**Then Phase 2:**
6. Red Flag detector cron (Supabase Edge Function)
7. AI brain (6-lens prompt via OpenRouter)
8. Decision card UI (Vercel pages)
9. Approve / Override flow with mandatory expected_outcome
10. Monthly learning loops (gated by human approval)
11. Strategy / Planning tab
12. Deploy + access controls

---

## 14. Out of scope (sibling tools, don't merge)

Post-event Audience Insights PPTX · GA4 Province Audience Behavior · KSA Membership Projection · Google Travel Analytics Center · Adjust mobile-app data (v2+) · TikTok/Snap/Bing direct integration (v2+).

---

## 15. Companion docs (in this folder)

- `CLAUDE.md` — Code mode's session-startup briefing
- `campaign-optimization-sop.md` — full framework spec
- `campaign-optimization-data-map.md` — data inventory deep dive
- `campaign-optimization-brief.md` — this file
- `campaign-review-runbook.md` — standalone single-event review runbook

---

*Status: Phase 1b actively building. Code mode handling implementation. Cowork is strategy fallback. Last sync: BQ wired ✅, T1 passed inch-by-inch against Marketing Insights screenshot ✅, T2 blocked on Supabase key paste.*
