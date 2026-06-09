# CLAUDE.md — Campaign Optimization Dashboard

Read this file every session before doing anything else. Three companion docs live alongside it: `campaign-optimization-sop.md` (full framework), `campaign-optimization-data-map.md` (data sources), `campaign-optimization-brief.md` (single-page summary). Read them at the start of each new task and ground every decision in them.

## What this dashboard does

Surfaces ~33 active paid campaigns per session (Mon / Wed / Fri) as decision cards. Each card walks ALL 6 lenses (Internal → Meta → Google → GA4 → Last Week → Market), proposes one of 6 actions (KILL / PAUSE / OPTIMIZE / SCALE / REMARKET / HOLD), and waits for human approval. Approved decisions log to a feedback loop that retrains the playbook monthly via gated approvals.

## Slot system — the AI does NOT pick campaigns

The Mon/Wed/Fri assignment is **human-curated, not AI-decided**. Campaigns are assigned to Review Slot 1 / 2 / 3 in the **`database` tab** of the campaign ledger Google Sheet, and the assignment is **mostly permanent** with occasional manual moves. The sheet is the source of truth.

- Sheet-syncer Edge Function reads the `database` tab **hourly** → upserts into `dca_campaign_ledger` (key = first `event_id` in cell, full list stored in `event_ids text[]` for festival/multi-event landing pages).
- **Slot day mapping: `review_slot = 1` → Monday, `2` → Wednesday, `3` → Friday.**
- Red Flag detector loops only over `dca_campaign_ledger WHERE review_slot = today's_slot AND status = 'running' AND days_since_launch >= 7`.
- Rows missing from the sheet are **soft-deleted** (`status = 'inactive'`) — never row-deleted.
- Status is normalised on write against an allowlist: `running`, `ended`, `stopped`, `cancelled`, `paused`, `postponed`, `soldout`. Anything starting with `ended` (e.g. "Ended - event sold out") maps to `ended`. Empty or unrecognised values become `unknown` and are logged for review (sheet never mutated).
- **v1 sync path:** Edge Function fetches the sheet's **public CSV export** (`https://docs.google.com/spreadsheets/d/.../export?format=csv&gid=0`) — no auth, no service account, no GCP API enablement. Sheet stays "Anyone with link can view." This is a documented v1 trade-off for shipping speed: the ledger contains budgets + organizer emails, so a leaked URL = a real exposure. **Phase 2 hardening task:** lock sheet to "Specific people," add `claude-mcp-analyst@platinumlist-1014.iam.gserviceaccount.com` as Viewer, enable Sheets API in project `platinumlist-1014`, switch the Edge Function to Sheets-API auth. Service-account creds (when used) live in Supabase env var only — never in code.

## Stack

- **Frontend:** Next.js 14 (App Router) on Vercel free tier
- **Backend:** Supabase Edge Functions (cron) + service-role auth
- **Primary read warehouse:** Google BigQuery (read-only via service account)
- **Secondary warehouse:** Supabase project `kwftlkfvtglnugxsyjci` (marketing)
- **AI gateway:** OpenRouter (one key, multi-model routing)
- **Model routing:** Claude Haiku 4.5 (routine cards) · Claude Sonnet 4.6 (hard analog matching) · Perplexity Sonar (web search) · DeepSeek R1 (monthly learning loops) · Gemini Flash (fallback)

## Database — hard rules

**App code references ONLY two prefixes:**
- `dca_*` — 9 writeable tables this dashboard owns
- `dca_v_*` — 16 read-only views (windows into existing tables, physically cannot modify source)

**Never reference original tables (`dream_facebook`, `event_relational_db`, `sotm_events`, etc.) by name in code.**

### Writeable tables (`dca_*`)
`dca_decisions` · `dca_red_flag_events` · `dca_prompt_overrides` · `dca_cluster_baselines` · `dca_event_baselines` · `dca_source_a_cases` · `dca_source_b_notes` · `dca_proposed_rules` · `dca_campaign_ledger`

### Read-only views (`dca_v_*`)
`dca_v_meta_ads` · `dca_v_meta_custom_conversions` · `dca_v_google_ads` · `dca_v_events` · `dca_v_event_sales_daily` · `dca_v_marketing_share` · `dca_v_event_sales_prior` · `dca_v_event_source_medium` · `dca_v_affinity` · `dca_v_similar_events` · `dca_v_competitor_prices` · `dca_v_competitor_events` · `dca_v_competitor_meta_ads` · `dca_v_competitor_google_ads` · `dca_v_ga4_pages` · `dca_v_ga4_paid_campaigns` · `dca_v_event_campaign_overrides` · `dca_v_tracked_events` · `dca_v_optimisation_notes`

All 9 `dca_*` tables have RLS enabled — only the service-role key reads/writes.

### BigQuery tables (read directly via service account)

Project: `platinumlist-1014`, dataset: `ai_dataset`.

- `completed_orders` — **THE SALES TRUTH** (2016-2026). Revenue + tickets + orders + event metadata.
- `channels_3_campaign_level_llm` — **THE AD METRICS TRUTH for Meta + Google + all platforms.** Spend (`spend_aed`), impressions, clicks, conversions (`total_quantity`), revenue (`total_revenue_aed`). LLM-tagged `event_id` mapping. Read this NOT `dca_v_meta_ads`/`dca_v_google_ads` for spend/impressions/clicks/CTR/CPC.
- `GA4_funnel_LP_table` — **THE FUNNEL TRUTH** (LP / Cart / Checkout / Purchase columns per event per session_date).
- `GA4_marketing_share_by_channels` · `DB_total_tickets_by_event_ORG_edition` · `event_affinity_trough_users` · `category_affinity_trough_users` · `marketing_tag_affinity_trough_users`

### CRITICAL ALIGNMENT RULE — match the Marketing Insights Dashboard exactly

The team already runs a Marketing Insights Dashboard built on the same warehouse. Our per-event Meta/Google/sales/funnel numbers **must match it inch-by-inch** so the team trusts both. The Notion doc: `https://platinumlist-autoads.notion.site/Marketing-Insights-Dashboard-new-looker-Technical-Documentation-356349fa080380d0802ff831e646d4b9`.

Source-of-truth rules:

1. **Spend / Impressions / Clicks / CTR / CPC** for ALL platforms → BQ `channels_3_campaign_level_llm` ONLY. Do NOT use `dca_v_meta_ads.spend_aed` or `dca_v_google_ads.spend_aed`.
2. **Meta tickets + revenue** → Supabase `dream_facebook_custom_conversions` with the 3-tier primary-label rule (below) + scaling by `avg_tickets_per_order` + cap.
3. **Google / TikTok / non-Meta tickets + revenue** → BQ `channels_3_campaign_level_llm.total_quantity` + `total_revenue_aed`.
4. **Total sales / tickets sold / orders / avg ticket price / avg tickets per order** → BQ `completed_orders` ONLY. Do NOT use `dca_v_event_sales_daily` as primary — GA4 sotm is close but not the backend orders truth.
5. **Funnel** → BQ `GA4_funnel_LP_table` ONLY.
6. **Manual campaign attachments** → `dca_v_event_campaign_overrides` (view over `lnd_event_campaign_overrides`). Read in every per-event ads query — auto-match catches campaigns following `_<eventId>_` + `_CC_` naming convention; manual overrides cover the misses.
7. **Tracked-event allowlist** → `dca_v_tracked_events` (view over `lnd_tracked_events`).
8. **Cross-reference Source B** → `dca_v_optimisation_notes` (view over `lnd_optimisation_notes`) — read the existing dashboard's weekly notes alongside our own `dca_source_b_notes` for richer Lens 5.

### dca_v_meta_ads / dca_v_google_ads — demoted role

Still useful for **Meta-specific ancillary fields NOT in BQ**:
- Frequency (Meta ad fatigue signal)
- Ad-set-level creative names / breakdowns
- Per-ad performance (ad_name level)

**Primary spend/impressions/clicks/CTR/CPC = BQ. These views = supplementary.**

### Meta Attribution — 3-tier primary-label rule (port verbatim from `src/lib/data/meta.ts`)

When joining Meta CC firings to a campaign, infer the campaign's "conversion goal" CC label using this fallback. Must match the existing dashboard's TypeScript implementation exactly.

**Tier 1 — Event-ID match (preferred):**
1. Extract event_id from campaign name: regex `_(\d{4,7})_`. Example: `Abdulrahman-Aljunaid_UAE_105811_CC_8May` → `105811`.
2. Find CC labels containing event_id as standalone number (boundary-checked: `(^|[^0-9])<id>([^0-9]|$)`).
3. Multiple labels qualify → pick the one with most CC firings. That's the campaign's primary label.

**Tier 2 — Token-subset match (legacy fallback):**
1. Tokenize campaign name: drop stopwords + pure digits. `Abdulrahman-Aljunaid_UAE_105811_CC_8May` → `[abdulrahman, aljunaid, may]`.
2. Tokenize each CC label the same way.
3. Label "qualifies" if **every** label token is in campaign tokens.
4. Pick qualifying label with most firings.

**Tier 3 — Fallback:** if neither tier produced a match, fall back to Meta-pixel `purchases` for that campaign (UTM-based).

### Ticket-scaling (Meta CC → tickets)

Meta CC fires once per purchase, regardless of cart size. Scale:

```
meta_tickets = meta_cc_firings × avg_tickets_per_order
meta_revenue = meta_tickets × avg_ticket_price
```

`avg_tickets_per_order = SUM(tickets_count) / COUNT(DISTINCT id_order)` per event from BQ `completed_orders`.
`avg_ticket_price = SUM(amount) / SUM(tickets_count)` per event from BQ `completed_orders`.

### Cap logic — marketing tickets ≤ actual tickets sold

Apply per-event per-day:

```
raw_marketing_tickets = sum(meta_tickets + google_tickets + ...)
total_tickets = SUM(tickets_count) from completed_orders WHERE date = day
cap_ratio = MIN(1, total_tickets / NULLIF(raw_marketing_tickets, 0))

For each channel:
  capped_tickets = raw_tickets × cap_ratio
  capped_revenue = raw_revenue × cap_ratio
```

Guarantees marketing-attributed tickets never exceed reality. Apply in every Lens 2/3 scoring query.

## The 6-Lens Decision Engine

When a Red Flag fires, walk ALL 6 lenses in order. Each contributes — never stop early. Combine into one card with primary cause + contributing factors.

| # | Lens | Window | Primary-cause rule (high level) |
|---|---|---|---|
| 1 | **Internal** | 3d vs prior 3d | Sales below Conservative forecast × 0.85 AND drop spread across channels AND organic not growing → event-level issue |
| 2 | **Meta** | 7d vs T-7 | Weighted score 0-100 (Frequency, CTR, CPA, creative age, ROAS, WoW direction). Score > 60 = primary |
| 3 | **Google** | 7d vs T-7 | Weighted score 0-100 (ATI, CPC, wasted spend, conv rate, CPA band, WoW). Score > 60 = primary |
| 4 | **GA4** | 7d vs T-7 | AI weighted: bounce spike, checkout drop, mobile/desktop divergence, wrong-intent traffic, geo outliers |
| 5 | **Last Week** | last 4 weeks of decisions | Opposite-direction prediction failure OR same-action loop within 14d |
| 6 | **Market** | past 7d + next 14d | AI reasons: external factor explains part/all of gap. Daily macro scan + per-event artist scan |

**Reference data priority (every lens):**
1. Same event's own history (`completed_orders`)
2. Top 5 direct analogs (`dca_v_similar_events`, weighted by affinity)
3. Affinity siblings currently running
4. Cluster baseline (`dca_cluster_baselines`) — **last resort only**

Full lens specifications in `campaign-optimization-sop.md` §4.

## Red Flags (the only trigger)

| Red Flag | Threshold |
|---|---|
| Marketing ticket share | < 15% |
| Meta CPA | > AED 150 OR > 1/10 ticket price (stricter wins) |
| Google CPA | Outside 5-25% of ticket price |
| CPA streak | Rising 3 days in a row |
| ROAS / Revenue WoW | Down WoW |
| CTR drop | > 20% (7d vs prev 7d) |

**Include all campaigns regardless of budget.** New campaigns < 7 days old = HOLD, no Red Flag fires.

## Environment variables (Vercel)

```
SUPABASE_URL=https://kwftlkfvtglnugxsyjci.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<from Supabase → Settings → API>
OPENROUTER_API_KEY=<from openrouter.ai>
GCP_BQ_SERVICE_ACCOUNT_JSON=<base64-encoded JSON key from manager>
```

## Sacred rules — never violate

1. **No action executes without human click.** Dashboard suggests; user approves. No auto-pause, no auto-kill, no auto-scale — even budget breaches.
2. **Approve button refuses to submit if expected-outcome field is empty.** Every decision logs a one-line prediction.
3. **Walk all 6 lenses every time.** Never stop early. Primary cause + contributing factors all shown.
4. **Never touch original tables.** Code references only `dca_*` and `dca_v_*` names.
5. **Forecast = use existing Event Sales Forecasting skill.** Curve-based, 3 scenarios (Conservative/Moderate/Optimistic). Never linear projection.
6. **Cluster baselines = last resort.** Always prefer event's own history → direct analogs → affinity siblings before falling back.
7. **Lens 1 first, Lens 6 last.** Never let "the market" be the answer until Lenses 1-5 have been examined.
8. **Event Category column on `dca_v_campaign_ledger` is the cluster key.** Don't infer category from `marketing_tags` arrays.
9. **Agency rule — no cross-event budget reallocation.** Platinumlist is an agency; each event is funded by its own organizer (Live Nation, Shurooq, etc.). NEVER recommend moving budget between events — that's moving one client's money to another's. Budget reallocation recommendations are allowed ONLY *within* a single event: Meta vs Google, ad set vs ad set, audience vs audience, creative vs creative. If an event is underperforming and within-event optimization can't fix it, the right action is "escalate to human" — never "redirect budget elsewhere in the portfolio."
10. **Security — no keys in code or docs.** Never embed API keys, service-account JSON, Supabase service-role keys, or any secret in `.md` files, comments, README, code strings, or git commits. All secrets go in Vercel env vars (encrypted at rest). `.gitignore` must include `.env`, `.env.local`, `.env.production`, `*.json` (BQ keys), and any file matching service-account JSON shape. Never log secret values in console output, error messages, or telemetry. If a key is ever accidentally exposed in git history, rotate it immediately.

## Phase 1b — first build tasks

1. **Scaffold** — init GitHub repo + Next.js 14 + Vercel project + wire Supabase + OpenRouter env vars. Blank dashboard page. ✅
2. **Sheet-syncer Edge Function** — pulls [campaign ledger Google sheet](https://docs.google.com/spreadsheets/d/1zQnQudbjsUhCSZwSaOW9w7AO1-YX-7YL1xmessJGQew/edit?gid=0#gid=0) **hourly** via Sheets API + service account → `dca_campaign_ledger`. ✅ (re-verify via Sheets API path after sheet is shared with the SA)
3. **Data layer (T1–T5)** — `src/lib/bigquery.ts`, `src/lib/data/bq-event.ts` (sales), `src/lib/data/meta.ts` (Tier 1/2/3 attribution), `src/lib/data/cap.ts` (window-level cap), `src/lib/data/events.ts` (`getEventReport` orchestrator). Validated against Marketing Insights Dashboard on Russell Peters 104963 / 2026-06-01→07: revenue / tickets / orders / sales / clicks / CTR match to the dirham; ~0.3% spend variance accepted (per-day FX rounding artefact, no decision impact). ✅
4. **Cluster-baselines Edge Function** — joins `dca_v_meta_ads` × `dca_v_events` over 12mo, GROUP BY (event_category, price_band), populates `dca_cluster_baselines` monthly. ✅
5. **Debug page** — static "I can see all my data" — row counts for every `dca_v_*` view, ingest status for the campaign ledger. ⏳
6. **BQ smoke test** — service account JSON wired into Vercel env, sanity queries on `completed_orders` and `channels_3_campaign_level_llm`. ✅

Phase 1b is functionally done (data layer proven, sync built and reconciled). Then Phase 2 = the AI brain (OpenRouter + 6-lens prompt) + decision card UI + learning loops + Strategy tab.

## Phase 2 — roadmap

- **P2.1 Red Flag detector** — Edge Function/cron scans `dca_campaign_ledger WHERE review_slot = today AND status = 'running' AND days_since_launch >= 7`, computes the 6 Red Flag thresholds, writes hits to `dca_red_flag_events`.
- **P2.2 6-Lens AI brain (OpenRouter)** — for each Red Flag firing, call `getEventReport`, walk Lens 1→6 in order, return structured JSON `{ primary_lens, contributing_lenses, diagnosis, recommended_action, confidence, expected_outcome_template, reasoning }`. Haiku for routine, Sonnet for analogs, Perplexity for Lens 6.
- **P2.3 Decision card UI** — Mon/Wed/Fri page; all 6 lenses expanded; mandatory `expected_outcome` textbox (Approve disabled until filled); Override dropdown for the 6 actions. Approved decisions write to `dca_decisions`.
- **P2.4 Learning loops** — monthly job: for closed decisions (event ended or 14d elapsed), compute actual vs expected. DeepSeek R1 reads failure patterns → `dca_proposed_rules`. Human promotes to `dca_prompt_overrides`.
- **P2.5 Strategy/Planning tab** — forward-looking view: upcoming events 0–90 days out, pre-campaign actions from analog priors.
- **P2.6 Deploy** — Vercel link, env vars set, cron schedules confirmed, RLS audit, end-to-end smoke on 3 events.

Order: P2.1 → P2.2 → P2.3 → deploy v1 → P2.4 → P2.5.

## How to talk to the user

The user (Musthafa) prefers: direct, no-fluff, honest assessments. Push back when something is overkill. Match their casual tone but stay precise. Brain-fog days are common — keep replies tight and scannable. When committing changes, write descriptive commit messages so the SOP/Data Map can be tracked. Don't make a fuss about file edits.
