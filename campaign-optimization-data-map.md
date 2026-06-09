# Campaign Optimization Dashboard — Data Map

**Every data source the dashboard touches, what's in it, which lens or Red Flag it feeds, and the isolation rules.**

Marketing Supabase project: `kwftlkfvtglnugxsyjci` (region: ap-south-1).
BigQuery project: `platinumlist-1014` (read-only via service account).

---

## 1. Isolation principle

**App code references ONLY two prefixes:**
- `dca_*` — 9 writeable tables this dashboard owns
- `dca_v_*` — 16 read-only views (windows into existing tables, physically cannot modify source)

**Never reference original table names** (`dream_facebook`, `event_relational_db`, etc.) in code. The views forward to the same data but are read-only by construction. Other teams' work stays untouched.

---

## 2. Writeable tables we OWN (`dca_*`) — already created in Supabase

| Table | Purpose | Schema highlights |
|---|---|---|
| `dca_decisions` | Every approved/overridden action + expected vs actual outcome | `campaign_id`, `event_id`, `review_slot`, `red_flags[]`, `lens_found_cause`, `ai_diagnosis`, `ai_suggested_action`, `ai_confidence`, `ai_recommendations` (JSONB), `final_action`, `reasoning`, `expected_outcome`, `approved_by`, `actual_outcome`, `outcome_correct` |
| `dca_red_flag_events` | Audit log of every Red Flag firing | `red_flag_type`, `metric_value`, `threshold`, `threshold_source`, `resolved`, `resolved_decision_id` |
| `dca_prompt_overrides` | Override + reason log → feeds monthly learning loop | `decision_id` (FK), `ai_suggested`, `human_override`, `override_reason` |
| `dca_cluster_baselines` | Median CPA/CTR/ROAS per cluster (refresh monthly, **last-resort use only**) | `event_category`, `sub_genre`, `price_band`, `venue_type`, `cpa_p25/p50/p75`, `ctr_p25/p50/p75`, `roas_p25/p50/p75`, `sample_size` |
| `dca_event_baselines` | Per-event rolling baseline (active after 7+ days of own data) | `event_id`, `platform`, `cpa_mean/std`, `ctr_mean/std`, `roas_mean/std`, `days_of_data`, `active_baseline_source` |
| `dca_source_a_cases` | Case studies with pgvector embeddings (AI auto-drafts monthly) | `sheet_row_id`, `event_id`, `event_name`, `category`, `outcome_type`, `story`, `reasoning`, `embedding` vector(1536) |
| `dca_source_b_notes` | Weekly review notes — auto-fed by dashboard on every Approve | `week_of`, `event_id`, `campaign_id`, `action_taken`, `reasoning`, `prediction`, `actual_outcome`, `author` |
| `dca_proposed_rules` | Cross-event / override learning proposals awaiting approval | `source` (cross_event / override), `proposed_rule`, `evidence` (JSONB), `status`, `reviewed_at`, `reviewed_by` |
| `dca_campaign_ledger` | Daily sync from campaign ledger Google sheet | `event_id`, `event_name`, `event_link`, `budget_aed`, `channels[]`, `event_ends`, `primary_campaign_manager`, `review_slot`, `country`, `status`, `report_v5_link`, `campaign_start_date`, `campaign_end_date`, `org_name`, `org_email`, `responsible_person`, `event_category` |

RLS enabled on all. Only service-role key reads/writes. Anon key is blocked.

---

## 3. Read-only views (`dca_v_*`) — already created in Supabase

| View | Forwards to | Used for |
|---|---|---|
| `dca_v_meta_ads` | `dream_facebook` (24k rows, Windsor.ai daily) | L2 |
| `dca_v_meta_custom_conversions` | `dream_facebook_custom_conversions` | L2 (Meta attribution) |
| `dca_v_google_ads` | `dream_google_ads` (75k rows) | L3 |
| `dca_v_events` | `event_relational_db` (1,316 rows) | every lens — event metadata join |
| `dca_v_event_sales_daily` | `sotm_events` (106k rows) | L1 — daily GA4 e-commerce per event |
| `dca_v_marketing_share` | `dashboard_events` (25k rows) | L1 — marketing ticket share Red Flag |
| `dca_v_event_sales_prior` | `recc_event_sales_prior` (8k rows) | Forecast baseline |
| `dca_v_event_source_medium` | `event_source_medium` (14k rows) | L4 — source/medium per event |
| `dca_v_affinity` | `recc_event_affinity` (4k rows) | L2, L3, L6 — audience seeds |
| `dca_v_similar_events` | `recc_similar_precomputed` (216k rows) | every lens — top 5 analog lookup |
| `dca_v_competitor_prices` | `pricey_log` (185k rows) | L3, L6 |
| `dca_v_competitor_events` | `selly_clean` (46k rows) | L3, L6 |
| `dca_v_competitor_meta_ads` | `competitor_ads` | L2, L6 — what competitors run on Meta |
| `dca_v_competitor_google_ads` | `google_competitor_ads` | L3, L6 |
| `dca_v_ga4_pages` | `ga4_pages_daily` (5.7k rows) | L4 |
| `dca_v_ga4_paid_campaigns` | `ga4_paid_campaigns_daily` | L4 |
| `dca_v_event_campaign_overrides` ★ | `lnd_event_campaign_overrides` | Manual campaign attachments by admin team — read in every per-event ads query |
| `dca_v_tracked_events` ★ | `lnd_tracked_events` | Admin allowlist of events that appear in reports |
| `dca_v_optimisation_notes` ★ | `lnd_optimisation_notes` | Existing Marketing Insights Dashboard's weekly notes (cross-ref with `dca_source_b_notes`) |

★ Added in latest session for **Marketing Insights Dashboard parity** alignment.

### ⚠️ Demoted role for `dca_v_meta_ads` and `dca_v_google_ads`

These views still exist and remain useful for **Meta-specific ancillary fields NOT available in BQ** (frequency, ad-set creative names, per-ad performance). **STOP using them as the primary source for spend / impressions / clicks / CTR / CPC.** Primary source for those metrics is now BQ `channels_3_campaign_level_llm` (see §4).

---

## 4. BigQuery tables (read directly via service account)

GBQ is the **primary read warehouse for truth-of-record data**. Project: `platinumlist-1014`, dataset: `ai_dataset`. Authenticated via service account JSON in Vercel env (`GCP_BQ_SERVICE_ACCOUNT_JSON`).

### CRITICAL ALIGNMENT RULE — Marketing Insights Dashboard parity

Per-event numbers must match the existing Marketing Insights Dashboard exactly:

| Metric | Source | Notes |
|---|---|---|
| Spend / Impressions / Clicks / CTR / CPC for ALL platforms | BQ `channels_3_campaign_level_llm` | This is THE source. Do NOT use `dca_v_meta_ads.spend_aed` or `dca_v_google_ads.spend_aed` for ad spend metrics. |
| Meta tickets + revenue | Supabase `dca_v_meta_custom_conversions` + Tier 1/2/3 rule + scaling + cap | See SOP §6 for exact attribution logic |
| Google / non-Meta tickets + revenue | BQ `channels_3_campaign_level_llm.total_quantity` + `total_revenue_aed` | LLM-tagged event_id, no regex needed |
| Total sales / tickets sold / orders | BQ `completed_orders` | `id_event` (INT64), `amount_aed`, `tickets_count` |
| Funnel | BQ `GA4_funnel_LP_table` | `event_id` (INT64), `session_date`. Stages: `users_on_lp → users_on_ticket_office → users_with_checkout → users_with_purchase`. No `users_add_to_cart` column — `users_on_ticket_office` is the cart-equivalent. |

| Table | What it holds | Used for |
|---|---|---|
| `completed_orders` | Full transaction history 2016–2026: user, event, revenue, UTM, platform, category | L1 (sales truth), L2/L3 attribution, forecast (curve extraction) |
| `channels_3_campaign_level_llm` | Campaign-level paid perf with **LLM-tagged event_id** + attraction_name + attribution frequency | L2, L3 — solves ads ↔ event linking without regex |
| `channels_campaign_level_llm_table` | Same minus attraction_name | Alternative when attraction dim not needed |
| `GA4_funnel_LP_table` | LP → ticket office → checkout → purchase funnel by source | L4 — primary funnel source |
| `GA4_marketing_share_by_channels` | Channel attribution share per event with full event metadata | L1, L4 — share validation |
| `DB_total_tickets_by_event_ORG_edition` | Event-level capacity, sell-through, revenue, marketing budget | L1 — capacity/sell-through check |
| `event_affinity_trough_users` | Event co-purchase per user | L2 audience seeds |
| `category_affinity_trough_users` | Category-level co-purchase | L1 cross-category demand check |
| `marketing_tag_affinity_trough_users` | Marketing tag co-occurrence per user | L3 cross-targeting suggestions |
| `GA4_and_marketing_ad_group_table` | GA4 sessions + paid ad spend merged at ad group level | Optional deeper L2/L3 join |

---

## 5. Sheet syncs (daily cron via Edge Functions)

| Source | Target table | Sync frequency | Notes |
|---|---|---|---|
| [Campaign ledger Google sheet](https://docs.google.com/spreadsheets/d/1zQnQudbjsUhCSZwSaOW9w7AO1-YX-7YL1xmessJGQew/edit?gid=0#gid=0) | `dca_campaign_ledger` | Daily | Source for review slot, budget, channels, manager, status, event category, Looker links |
| Source A case studies (sheet, separate from campaign ledger) | `dca_source_a_cases` | Daily, with embedding regeneration | Curated wins/losses. AI auto-drafts new entries monthly via cross-event learning |

**Source B** is NOT synced from a sheet — `dca_source_b_notes` is auto-populated by the dashboard itself every time a decision is Approved. The original `lnd_optimisation_notes` table is left untouched (someone else may be using it).

---

## 6. Web search (Perplexity Sonar via OpenRouter)

**Two-tier strategy** to balance freshness with cost.

| Type | Frequency | What it captures | Cost |
|---|---|---|---|
| Daily macro UAE scan | Once per day, cached | Salary cycle position, public holidays, Ramadan, weather, major UAE events next 14d | ~$0.01/day |
| Per-event artist scan | On-demand, cached per event for 24h. Triggered only when AI flags artist-specific context might matter | Artist trending, recent show sell-through, news mentions | ~$0.50/day worst case |

Total ~$15/month at full scale. Negligible.

---

## 7. Conflict resolution — picking one source of truth per metric

Multiple tables hold overlapping data. The AI is told which is primary; others are reference-only.

| Metric | Primary source | Secondary / fallback |
|---|---|---|
| Event revenue (truth) | BQ `completed_orders` | `dca_v_event_sales_daily` (GA4 view, daily cuts) |
| Daily sales curve | BQ `completed_orders` | `dca_v_event_sales_daily` for recent days |
| Marketing ticket share | `dca_v_marketing_share` | — (no conflict) |
| Competitor events | `dca_v_competitor_events` (selly_clean) | — |
| Competitor prices | `dca_v_competitor_prices` (pricey_log) | — |
| Active events list | `dca_v_events` (filtered to status='Running' via ledger) | `dca_v_campaign_ledger` for status |
| Affinity audience seeds | `dca_v_affinity` (`recc_event_affinity`) | — |
| Analog event lookup | `dca_v_similar_events` (`recc_similar_precomputed`) | — |
| Event embeddings | Existing `event_vectors` table (don't rebuild) | — |
| Ads ↔ event linking | BQ `channels_3_campaign_level_llm` (LLM-tagged) | — |
| Funnel data | BQ `GA4_funnel_LP_table` | `dca_v_ga4_pages` for page-level depth |

---

## 8. Reference data priority (every lens)

When AI pulls history to compare current performance, it prefers in this order:

1. **Same event's own history** (repeat events, from `completed_orders`)
2. **Top 5 direct analogs** (`dca_v_similar_events`, weighted by affinity score)
3. **Affinity siblings currently running** (live competitive comparison)
4. **Cluster baseline** (`dca_cluster_baselines`) — **last resort only**

Cluster baselines are risky (small sample sizes, broad categories, missed seasonality). Only used when 1-3 lack data.

---

## 9. Cluster baseline computation (when used)

Computed by monthly Edge Function:

```sql
-- pseudo
SELECT
  erd.categories,
  ledger.event_category,            -- direct from sheet, no inference
  CASE WHEN erd.min_price < 100 THEN 'low'
       WHEN erd.min_price < 400 THEN 'mid'
       ELSE 'high' END AS price_band,
  PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY df.cost_per_purchase) AS cpa_p25,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY df.cost_per_purchase) AS cpa_p50,
  PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY df.cost_per_purchase) AS cpa_p75,
  -- repeat for ctr, roas
  COUNT(*) AS sample_size
FROM dca_v_meta_ads df
JOIN dca_v_events erd ON [event linkage from BQ channels_3]
JOIN dca_v_campaign_ledger ledger ON erd.event_id = ledger.event_id
WHERE df.date > NOW() - INTERVAL '12 months'
GROUP BY erd.categories, ledger.event_category, price_band;
```

Refresh: monthly via cron Edge Function. Output written to `dca_cluster_baselines` (truncate + insert).

---

## 10. Red Flag → tables map

| Red Flag | Tables used |
|---|---|
| Marketing ticket share < 15% | `dca_v_marketing_share` + `dca_cluster_baselines` (only as fallback) + `dca_v_events` |
| Meta CPA > AED 150 / > 1/10 ticket price | `dca_v_meta_ads` + `dca_v_meta_custom_conversions` + `dca_v_events.min_price` |
| Google CPA outside 5–25% of ticket price | BQ `channels_3_campaign_level_llm` + `dca_v_events.min_price` |
| CPA streak 3d rising | `dca_v_meta_ads` / `dca_v_google_ads` time series |
| ROAS / Revenue WoW down | BQ `completed_orders` + `dca_v_meta_ads` / `dca_v_google_ads` joined via BQ `channels_3_campaign_level_llm` |
| CTR drop > 20% | `dca_v_meta_ads` / `dca_v_google_ads` (7d vs prev 7d) |

---

## 11. Lens → tables map (AI fetches these when walking each lens)

| Lens | Tables read |
|---|---|
| **L1 — Internal** | `dca_v_event_sales_daily` · `dca_v_marketing_share` · `dca_v_event_sales_prior` · `dca_v_events` · BQ `completed_orders` · `dca_v_competitor_prices` (for pricing check) |
| **L2 — Meta** | `dca_v_meta_ads` · `dca_v_meta_custom_conversions` · `dca_v_affinity` · `dca_v_similar_events` · `dca_v_competitor_meta_ads` · `dca_source_a_cases` (analog overlay) |
| **L3 — Google** | `dca_v_google_ads` · BQ `channels_3_campaign_level_llm` · `dca_v_ga4_paid_campaigns` · `dca_v_competitor_prices` · `dca_v_competitor_google_ads` · BQ `marketing_tag_affinity_trough_users` |
| **L4 — GA4** | BQ `GA4_funnel_LP_table` · `dca_v_ga4_pages` · `dca_v_event_source_medium` · BQ `GA4_marketing_share_by_channels` |
| **L5 — Last Week** | `dca_source_b_notes` · `dca_decisions` (last 4 weeks) · `dca_prompt_overrides` |
| **L6 — Market** | Web search (Perplexity, cached) · `dca_v_competitor_events` · `dca_v_competitor_prices` · BQ `GA4_marketing_share_by_channels` (industry context) |

---

## 12. Things deliberately SKIPPED for v1

- n8n (direct Edge Functions cover it)
- Slack digest (add later if useful)
- Tabby / payment API direct integration (signal comes via GA4 funnel anyway)
- TikTok / Snapchat / Bing / Criteo / LinkedIn ads — schema exists in `dream_*` but not used in v1 (focus on Meta + Google)
- Reviews data (`reviews`) — not needed for campaign optimization
- HubSpot CRM (`hs_*`) — B2B side, not B2C campaign optimization
- Google Travel Analytics Center (TAC) — different channel, sibling tool
- Post-event review PPTX skill — sibling tool, can pipe sentiment themes into Source A later
- Mobile app Adjust data — v2+

---

## 13. Open items for humans

| Item | Resolution path | Who |
|---|---|---|
| BQ service account JSON | Request from manager who maintains `recc_event_sales_prior` sync. Read-only access scoped to marketing dataset. Use the email template I drafted. | You → Manager |
| GitHub repo | Personal email is fine for test phase. Sign up at github.com if you don't have one. | You |
| Vercel account | Sign in via GitHub (one click). Free tier covers test phase. | You |
| OpenRouter API key | openrouter.ai → Settings → Keys → Create. Takes 30 seconds. | You |
| Supabase service-role key | Supabase dashboard → Project `kwftlkfvtglnugxsyjci` → Settings → API → copy `service_role` key. Keep secret. | You |

---

## 14. Sacred rules

1. Never reference original tables in code — `dca_*` and `dca_v_*` names only.
2. Never write to existing tables — read via views only.
3. All `dca_*` writes go through the service-role key. Anon key blocked by RLS.
4. BQ access is read-only via service account.
5. Cluster baselines are last-resort reference data only.
6. **Agency rule** — no cross-event budget reallocation (each event funded by different organizer). Reallocation only within a single event.
7. **Security** — no secrets in code or docs. All keys in Vercel env or `.env.local` (gitignored). Block `*service-account*.json`, `gcp-*.json`, `*-credentials*.json`, `*.key.json` patterns. Never log secret values.

---

*Source of truth: this document. Latest update: Phase 1b wiring in progress. BQ wired ✅, T1 (BQ queries) passed Marketing Insights Dashboard parity check on Russell Peters event 104963 ✅. T2 (Meta Tier 1/2/3) in progress.*
