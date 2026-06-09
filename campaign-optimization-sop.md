# Campaign Optimization SOP — Decision Framework

**The simple idea:** watch a small set of **Early Warning Metrics** every day, treat **Red Flags** as the only "stop and look" signal, and when one fires, walk the **6-Lens Investigation** in order to find the real cause, apply the playbook, and log it.

Three loops, in this order:

1. **Watch** — Early Warning Metrics. Catch dips *before* a Red Flag fires.
2. **Diagnose** — When a Red Flag fires, walk all 6 Lenses (Internal → Meta → Google → GA4 → Last Week → Market). Each lens contributes — never stop early.
3. **Act** — Apply the playbook. Collapse the call to one of 6 actions. Log it. Predict the outcome.

The dashboard automates Watch + the *detection* and *context-pulling* parts of Diagnose. You do the call and the prediction. **No action ever executes without your click.**

**Cadence:** Mon / Wed / Fri review sessions, ~33 campaigns per session. Slot assignment from `dca_v_campaign_ledger.review_slot`.

---

## 1. Data sources

| Source | What it gives | Which lens it feeds |
|---|---|---|
| **Live ads** (`dca_v_meta_ads`, `dca_v_google_ads` — via Windsor.ai daily) | Meta + Google spend, impressions, clicks, CTR, frequency, conversions | L2 (Meta), L3 (Google) |
| **BigQuery `completed_orders`** | Sales, tickets, orders, event metadata — truth for revenue + tickets | L1, attribution math |
| **BigQuery `channels_3_campaign_level_llm`** | Campaign-level paid perf with LLM-tagged event_id (solves ads ↔ event linking) | L2, L3, attribution |
| **BigQuery `GA4_funnel_LP_table`** | 4-stage funnel: LP → cart → checkout → purchase | L4 |
| **BigQuery `GA4_marketing_share_by_channels`** | Channel attribution share per event with full event metadata | L1, L4 |
| **`dca_v_meta_custom_conversions`** | Per-CC-label Meta firings (accurate Meta attribution) | L2, attribution |
| **`dca_v_event_sales_daily`** | GA4 e-commerce per event, daily, AED | L1 |
| **`dca_v_marketing_share`** | Marketing ticket share data (mkt, share, rev) | L1 (Red Flag) |
| **`dca_v_affinity`, `dca_v_similar_events`** | Co-purchase graph + 216k pre-computed similar event pairs | L2, L3, L6, forecasting |
| **`dca_source_a_cases`** (synced with embeddings, AI auto-drafts monthly) | Notable wins/losses, curated case studies | L1, L2 (analog overlay) |
| **`dca_source_b_notes`** | Weekly decisions, predictions, outcomes — auto-fed by dashboard | L5 (mandatory) |
| **`dca_v_competitor_prices`, `dca_v_competitor_events`** | Pricey + Selly comp data | L3, L6 |
| **`dca_v_competitor_meta_ads`, `dca_v_competitor_google_ads`** | Comp ad creative | L2, L3, L6 |
| **`dca_v_campaign_ledger`** (synced from Google sheet daily) | Per event: review slot, budget, channels, manager, status, category, Looker links | Routing, ownership, cluster baselines |
| **`dca_v_event_campaign_overrides`** (over `lnd_event_campaign_overrides`) | Manual campaign-to-event attachments by admin team | L2, L3 (read in every per-event ads query) |
| **`dca_v_tracked_events`** (over `lnd_tracked_events`) | Admin allowlist of which events appear in reports | Routing filter |
| **`dca_v_optimisation_notes`** (over `lnd_optimisation_notes`) | Existing Marketing Insights Dashboard's weekly notes per event | L5 (cross-reference alongside `dca_source_b_notes`) |
| **Web search (OpenRouter → Perplexity Sonar)** | UAE events, artist trends, real-time context | L6 |

**Sacred rule on data:** app code references only `dca_*` (writeable) and `dca_v_*` (read-only views) prefixed names. Never reference original tables directly. BigQuery accessed via service account, read-only.

---

## 2. WATCH — Early Warning Metrics (daily, prevent next dip)

These are not alerts to act on. They are trends to *monitor* so you catch decay before a Red Flag fires.

| Metric | Trigger threshold | What it predicts | Pre-emptive action |
|---|---|---|---|
| CTR curve | Dips 30% from peak | Creative fatigue → CPA will rise next | Refresh creative *before* CTR fully drops |
| Google search volume | Trending down 3+ days | External demand cooling → cold Meta will waste budget | Scale Meta cold spend down |
| Remarketing pool size | Shrinking | Pipeline drying — warm audience running out | Re-feed pipeline with cold + content |
| Bounce rate | Rising | LP / pricing / load problem brewing | GA4 deep dive on funnel before sales drop |

If **two of these trip at the same time on the same event**, treat as a soft Red Flag — start Diagnose immediately.

---

## 3. DIAGNOSE — Step 1: Red Flags (the trigger)

A campaign generates a decision card only when one of these fires.

| Red Flag | Threshold | Computed from |
|---|---|---|
| Marketing ticket share | < 15% | `dca_v_marketing_share.share` |
| Meta CPA absolute | > AED 150, *or* > 1/10 ticket price (whichever stricter) | `spend_aed / (custom_conversions × avg_tickets_per_order)` — see §6 |
| Google CPA | Outside **5% – 25%** of ticket price band | `spend_aed / total_quantity` from `channels_3_campaign_level_llm` |
| CPA streak | Rising 3 days in a row | Time series per campaign |
| ROAS / Revenue WoW | Down WoW | Capped attribution revenue / spend |
| CTR drop | Dropped > 20% (7d vs prev 7d) | `dca_v_meta_ads` / `dca_v_google_ads` |

**Include all campaigns regardless of budget.** No spend exclusion. Confidence score will naturally be lower on small samples.

**New campaign rule:** if < 7 days old, no Red Flag fires — HOLD status until stabilized.

---

## 4. DIAGNOSE — Step 2: The 6-Lens Investigation

When a Red Flag fires, **walk all 6 lenses in order**. Each contributes. Multiple causes can coexist — never stop early.

The decision card will show:
- **Primary cause lens** — the one with the strongest signal score
- **Contributing factors** from other lenses that also fired
- Recommendations grouped per lens

**Reference data priority** (applies to every lens):
1. Same event's own history (repeat events — from `completed_orders`)
2. Top 5 direct analogs from `dca_v_similar_events` weighted by affinity score
3. Affinity siblings currently running (live competitive comparison)
4. Cluster baseline (`dca_cluster_baselines`) — **last resort only**, when 1-3 lack data

---

### Lens 1 — Internal sales performance (FIRST — always)

**Question:** *Are we delivering? Before checking ads, channels, or the market — what's the event's own sales trajectory saying?*

**Window:** rolling 3 days vs immediately prior 3 days (6-day window).

**Checks:**
| Check | What it tells you |
|---|---|
| 3d-vs-3d sales delta | Acceleration or deceleration in real time |
| Forecast vs actual gap | Tracking below/on/above the 3-scenario projection |
| Marketing ticket share trend | Is paid still pulling its expected portion? |
| Ticket sold % of capacity | Sell-through health |
| Days to event | Urgency modifier |

**Primary-cause rule (Lens 1 owns it when):**
```
actual_sales_3d < Conservative_forecast_3d × 0.85
  AND |Meta_decline_pct − Google_decline_pct| < 15
  AND organic share is stable or growing
```
Translation: sales below Conservative forecast AND drop spread evenly across channels AND organic isn't picking up slack = the EVENT itself is the problem, not the ads.

**Playbook (ranked — AI surfaces in this order):**
1. Warm-list email + WhatsApp push (cheapest lift, uses existing buyers)
2. Pricing check vs `dca_v_competitor_prices` for same date/category — if we're 20%+ more expensive, recommend price cut or flash deal
3. Affinity-based remarketing — top 3 affinity siblings from `dca_v_similar_events` that recently sold, retarget their buyers
4. Capacity reality check — if 90% sold with 30 days left, "low sales" might be fine
5. Strategic escalation — if 1-4 don't apply, flag for human: "event-level problem, consider portfolio reallocation"

**Days-to-event modifier:**
| Days left | Playbook urgency |
|---|---|
| 30+ | Hold. Email push only. Don't spend big yet. Curve back-loads — early underperformance often noise. |
| 14–30 | Multi-front: email + pricing + affinity remarket |
| 7–14 | Danger zone. Steps 1–4 in parallel. Loosen ROAS limit. |
| 3–7 | Triage. Flash discount on table. Empty seats > ROAS target. |
| < 3 | Damage control. Maximum spend on best-converting platform. Last-chance creative. |

**History to pull:** `completed_orders` for the event's own past curves (repeat events) → `dca_v_similar_events` for top 5 analogs → `dca_v_event_sales_prior` for forecast baseline.

---

### Lens 2 — Meta Deep Dive

**Question:** *Is Meta the cause? Fatigue, audience mismatch, pipeline drying, creative decay, or wrong audience type?*

**Window:** 7d vs same 7d last week (T-7), aligned WoW.

**Primary-cause weighted score (0-100):**
```
Frequency overrun: (freq − 2.5) × 15  if > 2.5, capped at 30
CTR gap vs direct analogs: max(0, (analog_ctr − actual_ctr) / analog_ctr × 25)
CPA overrun vs direct analogs: max(0, (actual_cpa − analog_cpa) / analog_cpa × 25)
Creative age penalty: (days_since_refresh − 14) × 1 if > 14, capped at 15
ROAS gap vs direct analogs: max(0, (analog_roas − actual_roas) / analog_roas × 20)
WoW direction: −10 (improving) / +5 (flat) / +15 (declining)

Sum, cap at 100.

Score > 60 → Meta is primary cause
30 ≤ Score ≤ 60 → contributing factor
Score < 30 → Meta is healthy
```
*Cluster baselines used only when direct analogs unavailable.*

**Playbook style:** the 7-row pattern table is PRIORS, not hardcoded rules. AI reasons using priors + live data + Source A + affinity siblings + analogs.

**Pattern priors (reference):**
| Pattern | Cause | Playbook hint |
|---|---|---|
| Frequency > 2.5 | Ad fatigue | Broader audience / new asset / pause if not converting |
| CTR < 1% | Audience or creative mismatch | Fix one lever at a time |
| CPA spike WoW on remarketing specifically | Remarketing pipeline drying | Re-feed top-of-funnel; broaden window |
| Frequency diverges sharply WoW | Saturation accelerating | Pre-emptive creative refresh |
| CTR trend down 3+ days | Creative decay | Refresh, don't re-bid |
| Broad hurting / RM fine (or vice versa) | Audience type is the lever | Reallocate budget between types |

**History layers:**
- Top 5 analogs from `dca_v_similar_events`
- Affinity-sibling winning audiences → **auto-suggested as tests** on the card
- Source A analog overlay via embedding search
- Fall back to cluster baseline only if all above empty

---

### Lens 3 — Google Deep Dive

**Question:** *Is Google the cause? Keyword mix, CPC pressure, pricing arbitrage, awareness gap (ATI), wasted spend?*

**Window:** 7d vs T-7 (same as L2).

**Primary-cause weighted score (0-100):**
```
ATI overrun (>90 + sales below Conservative): 15
CPC vs same-event-history (cluster fallback): 10
Wasted spend ratio (non-converting kws / total): 15
Conversion rate vs direct analogs: 20
CPA outside 5–25% of ticket price: 20
WoW direction: 15

Sum, cap at 100.
Score > 60 → Google is primary cause
30 ≤ Score ≤ 60 → contributing factor
```

**ATI logic:** when ATI (Top Impression Share) close to 100 AND sales low = we're winning the auction but people aren't buying. That's a demand/pricing signal, NOT a media-execution signal. Spending more on Google won't help. Right moves: PMax/Display awareness expansion OR pricing review (route to Lens 4 for funnel check).

**Playbook style:** AI reasons. Pattern table is priors only.

**History layers (deeper than L2):**
1. Same artist/venue/event lineage from `completed_orders` — direct comparison
2. Affinity siblings currently running ads — winning kws + audiences right now
3. Branded vs non-branded search trend split (high branded + low conversion = pricing issue; low branded = awareness gap)
4. Marketing tag co-occurrence from `marketing_tag_affinity_trough_users` — cross-targeting suggestions
5. Geo concentration shift from `dca_v_event_source_medium` + `recc_geo_lang_purchases_raw`
6. Top 5 analogs from `dca_v_similar_events`
7. Cluster baseline (last resort)

---

### Lens 4 — GA4 funnel & UX

**Question:** *Did people make it through the funnel, or did the page kill them?*

**Window:** 7d vs T-7.

**Primary-cause signals (AI weights):**
- Bounce rate spike on event LP vs same event last year
- Funnel drop at checkout > X% (from `GA4_funnel_LP_table`)
- Mobile vs desktop drop divergence
- High traffic source/medium with zero conversion (wrong-intent or broken LP)
- Geographic outlier (high traffic from a city that never converts)

**Playbook style:** AI reasons. Pattern table is priors.

**Pattern priors (reference):**
| Pattern | Cause | Playbook hint |
|---|---|---|
| Bounce rate spike + no media change | LP/pricing/load issue | Dev ticket — not a media change |
| Checkout step drop spike | Tabby/payment/UX issue | Manual check + dev ticket |
| Mobile bounce > desktop bounce | Mobile UX or load speed | Mobile-specific dev fix |
| Source/medium high traffic / zero conv | Wrong-intent traffic OR tracking break | Audit UTMs + traffic source |
| Geographic outlier underperforming | Wrong-geo targeting | Tighten geo bid/exclusions |

**History layers:**
- Same event LP conversion rate vs last year (from `completed_orders`)
- `GA4_funnel_LP_table` stage drop comparison
- Source A cases tagged with "LP issue" via embedding search
- Direct analog comparison > cluster baseline

---

### Lens 5 — Last Week Review

**Question:** *Did we already touch this campaign? Did our last action work? Are we about to repeat a mistake?*

**Lookback window:** last **4 weeks** of decisions on this campaign (~12 review sessions).

**Primary-cause rule:**
```
STRONG (Lens 5 owns primary cause):
  - Last intervention's actual outcome moved OPPOSITE direction to prediction
    (e.g. predicted +20% CTR, actual is −10%)
  - OR same action proposed within last 14 days = LOOP detected

CONTRIBUTING (Lens 5 is contributing factor):
  - Last intervention's actual outcome was flat (no movement)
  - 3+ interventions on this campaign in last 4 weeks with no upward trend
    (thrashing pattern)

HEALTHY:
  - Last prediction held within ±10% of expected
  - No prior interventions in 4-week window
```

**Playbook:** context-dependent AI reasoning. AI reads the failed intervention from `dca_source_b_notes` + Source A analog + current data, then proposes:
- REVERT the last change immediately
- HOLD — give the change more time to bake
- ESCALATE to human — predictions keep being wrong
- Reasoned alternative — try X instead of repeating

**No-history fallback (new campaign):** pull last 4 weeks of decisions from affinity-similar events via `dca_v_similar_events`, surface PROMINENTLY at top of card as: *"Based on what worked for similar events: Anyma 2024 paused remarketing Wed → ROAS recovered Fri. Tale of Us 2025 increased budget Mon → predicted +30% CPA, prediction held."*

---

### Lens 6 — Market & external context

**Question:** *Is anything OUTSIDE our control affecting this campaign?*

**Window:** past 7 days + next 14 days.

**Primary-cause rule (no hardcoded threshold):**
```
AI reads daily-cached UAE market scan + dca_v_competitor_events + 
event-specific artist scan (if triggered) + outputs from Lenses 1-5.

Then asks: "Is there an external factor that explains PART or ALL 
of the current performance gap?"

Outcomes:
  - External factor + Lenses 1-5 clean → Lens 6 OWNS primary cause
  - External factor + Lenses 1-5 found cause → Lens 6 = contributing factor
    (adds to combined diagnosis)
  - No external factor → Lens 6 reports clean, still walked
```

**Playbook style:** context-dependent AI reasoning.

**Recommended actions when Lens 6 is significant:**
- Shift budget toward remarketing/warm audiences (don't fight the market for cold)
- Lower forecast / reset expectations (don't kill a campaign for missing a forecast built in calmer waters)
- Pause expensive cold acquisition, ride out with email + organic
- Wait for the cycle (no action — market will recover)

**Web search architecture:**
1. **Daily macro UAE scan** — one Perplexity Sonar query per day per UAE region. Covers: salary cycle position, public holidays, Ramadan, weather, major announced events in next 14d. Cached, shared by ALL event cards.
2. **Per-event artist scan** — on-demand, triggered only when AI flags artist-specific context might matter (big-name concerts where news moves demand). Cached per event for 24h.

Cost estimate: ~$15/month total. Negligible vs the value.

---

## 5. Diagnosis synthesis — assembling the decision card

After walking all 6 lenses, AI combines outputs into one card:

1. **Primary cause** — lens with highest signal score (or "no primary cause found, all systems healthy")
2. **Contributing factors** — every lens that scored > 30
3. **Recommendations** — 2–5 ranked by expected impact, each tied to a specific lens, with reasoning + estimated % lift (or % stop-loss for KILL cases)
4. **Suggested action** — one of the 6 actions (§7)
5. **AI confidence score** — 0–100, based on how cleanly signals aligned across lenses
6. **Suggested expected outcome** — plain-English prediction, editable by approver

---

## 6. Attribution math — exact spec (port from Marketing Insights Dashboard's `src/lib/data/meta.ts`)

### Source priority (Marketing Insights Dashboard parity rule)

| Metric | Source | NOT this |
|---|---|---|
| Spend / Impressions / Clicks / CTR / CPC — ALL platforms | BQ `channels_3_campaign_level_llm` | `dca_v_meta_ads.spend_aed`, `dca_v_google_ads.spend_aed` |
| Meta tickets + revenue | Supabase `dca_v_meta_custom_conversions` + Tier 1/2/3 + scaling + cap | UTM purchase counts |
| Google / non-Meta tickets + revenue | BQ `channels_3_campaign_level_llm.total_quantity` + `total_revenue_aed` | `dca_v_google_ads.conversions` |
| Total sales / tickets / orders | BQ `completed_orders` | `dca_v_event_sales_daily` |
| Funnel | BQ `GA4_funnel_LP_table` | — |
| Manual campaign attachments | `dca_v_event_campaign_overrides` | — |

### Meta Tier 1 / 2 / 3 primary-label rule

When joining Meta CC firings to a campaign, infer the campaign's "conversion goal" CC label using this fallback. Must match the existing Marketing Insights Dashboard exactly so Meta tickets/revenue numbers tie.

**Tier 1 — Event-ID match (preferred):**
1. Extract event_id from campaign name: regex `_(\d{4,7})_`. Example: `Russell-Peters_104963_UAE_CC_3Jun` → `104963`.
2. Find CC labels containing event_id as standalone number (boundary-checked: `(^|[^0-9])<id>([^0-9]|$)`).
3. Multiple labels qualify → pick the one with most CC firings.

**Tier 2 — Token-subset match (legacy fallback):**
1. Tokenize campaign name: lowercase, drop stopwords + pure digits. Stopwords list: `uae, ksa, qa, bh, om, egy, cc, ad, sa, ae, jun, jul, aug, sep, oct, nov, dec, jan, feb, mar, apr, may, live, at, in, the, presents`.
2. Tokenize each CC label the same way.
3. Label "qualifies" if every label token is in campaign tokens.
4. Pick qualifying label with most firings.

**Tier 3 — Fallback:** Meta-pixel `purchases` count (UTM-based) for that campaign.

### Ticket scaling

Meta CC fires once per purchase event (one order), so scale to ticket count to compare apples-to-apples with other channels:

```
meta_tickets = meta_cc_firings × avg_tickets_per_order
meta_revenue = meta_tickets × avg_ticket_price
```

`avg_tickets_per_order = SUM(tickets_count) / COUNT(DISTINCT id_order)` per event from BQ `completed_orders`.
`avg_ticket_price = SUM(amount_aed) / SUM(tickets_count)` per event from BQ `completed_orders`.

### Cap logic — marketing tickets ≤ actual tickets sold

Applied per-event per-day:

```
raw_marketing_tickets = sum(meta_tickets + google_tickets + ...)
total_tickets = SUM(tickets_count) from completed_orders WHERE date = day
cap_ratio = MIN(1, total_tickets / NULLIF(raw_marketing_tickets, 0))

For each channel:
  capped_tickets = raw_tickets × cap_ratio
  capped_revenue = raw_revenue × cap_ratio
```

Guarantees marketing-attributed tickets across all channels never exceed reality. Apply in every Lens 2 / Lens 3 scoring query.

### Manual campaign attachments

Read `dca_v_event_campaign_overrides` in EVERY per-event ads query. Schema: `event_id, campaign_name, platform, added_by, added_at, notes`. These are admin-curated mappings that catch campaigns the auto-naming convention misses (e.g., Meta campaigns without `_CC_` in the name, or Google campaigns the LLM pipeline mis-tagged). Auto-matches come from naming convention `_<eventId>_` + `_CC_` marker.

### Schema gotchas (real, caught during T1 build)

- `completed_orders.id_event` is INT64 (not `event_id`); revenue column is `amount_aed`
- `channels_3_campaign_level_llm.event_id` is STRING
- `GA4_funnel_LP_table.event_id` is INT64; `session_date` (not `date`)
- Funnel stages: `users_on_lp → users_on_ticket_office → users_with_checkout → users_with_purchase`. There is NO `users_add_to_cart` column — `users_on_ticket_office` IS the cart-equivalent

---

## 7. ACT — The 6 actions

Every decision must collapse to one of these. If it doesn't fit, you don't have a decision yet.

- **KILL** — stop, don't retry as-is
- **PAUSE** — stop temporarily, fix one thing, restart
- **OPTIMIZE** — keep running, change ONE lever (creative / LP / bid / audience / kw / price)
- **SCALE** — increase budget by ≤ 20% in one step
- **REMARKET** — build a paid follow-up off an organic/non-paid winner
- **HOLD** — leave alone, not enough data

---

## 8. The 5-question gate (mandatory before KILL or SCALE)

Answer YES to ≥4 of 5, or downgrade to OPTIMIZE/HOLD:

1. Is the data window ≥ 7 days *with healthy tracking the whole time*?
2. Is spend / impressions above the noise floor for this campaign size?
3. Has Lens 5 been checked — are we about to repeat or contradict last week's call?
4. Has Source A been checked for a similar past event that succeeded with a different setup?
5. Has the affinity table been checked for a better-fit audience we haven't tested?

---

## 9. Cluster baselines — last resort principle

Cluster baselines (`dca_cluster_baselines`) group historical events by (event_category, sub_genre, price_band, venue_type) and store p25 / p50 / p75 for CPA, CTR, ROAS.

**They are used ONLY when:**
- The event has no own history (`completed_orders` empty for it)
- No close analog in `dca_v_similar_events`
- No affinity sibling currently running

**Why "last resort":** small sample sizes per cluster, broad categories miss real similarity, seasonality not captured. Don't anchor decisions on cluster medians when direct comparisons exist.

Refresh: monthly cron rebuilds from `completed_orders` × event metadata × 12 months ad performance.

---

## 10. Forecasting — use existing Event Sales Forecasting skill

Per Platinumlist's existing forecasting skill (do NOT reinvent):

1. Find 2–3 comparable past events (auto via `dca_v_similar_events`)
2. Extract their daily sales curves from `completed_orders` — **exponential, not linear**
3. Average the curves → "sales shape"
4. Apply 3 scenarios: **Conservative / Moderate / Optimistic**
5. Apply venue/channel multiplier (CCA, Dubai Opera sell independently)

**Key insight:** D-1 ≈ 16% of last-17-day sales. Last 3 days ≈ 36%. Sales back-load heavily — never assume linear.

**Pitfalls (from the skill doc):**
- Don't use GA4 numbers as total sales — use `completed_orders`
- Don't ignore venue channel
- Don't extrapolate from < 14 days of history

Decision cards display Conservative / Moderate / Optimistic side-by-side.

---

## 11. Decision card structure (UI)

Each card surfaces:

- **Header** — event name, campaign, days to event, spend last 7d
- **Red Flag(s) that fired** — with metric values
- **6 Lenses row** — each marked ✓ ok / ⚠ off / 🔴 primary cause
- **Diagnosis** — 1–2 sentence plain-English narrative combining all lens findings
- **History references** — Source A analog · Source B last week note · Affinity sibling currently winning · Forecast vs actual
- **Recommendations (2–5)** — ranked, each with reasoning + estimated % lift or % stop-loss
- **Suggested action** — one of the 6
- **AI confidence score** — 0–100
- **Expected outcome field** — AI pre-fills plain-English prediction, editable, **required before submit**
- **Approve / Override buttons**
- **Approve refuses to submit if expected outcome is empty.**

---

## 12. Source A + Source B — knowledge loops

**Source A (`dca_source_a_cases`)** — case study library.
- AI auto-drafts new case studies monthly when notable anomalies occur (event broke its category baseline either way)
- Drafts go to Strategy tab for your approval
- Approved entries get embeddings and join Source A for future analog lookups
- **Self-curating knowledge base**

**Source B (`dca_source_b_notes`)** — weekly decisions + outcomes.
- Auto-written every time a decision is Approved on the dashboard
- Captures: event, campaign, action, reasoning, prediction, who approved, next review date
- Next review session fills in the `actual_outcome` field
- This is what Lens 5 reads. No manual maintenance after launch.

---

## 13. Learning loops — monthly, gated by your approval

Three loops run monthly via scheduled Edge Function:

**Adaptive baselines (continuous):** every event maintains a rolling baseline once it has 7+ days of own data. Red Flags fire when *this event* drifts off *its own* baseline by 2+ standard deviations.

**Cross-event learning (monthly):** AI reads last month's decisions, finds repeated patterns ("for electronic events, after frequency hits 2.7, ROAS always craters within 4 days"), proposes new rules into `dca_proposed_rules`. You approve/reject in Strategy tab. Approved rules join SOP prompt.

**Override learning (monthly):** AI reads `dca_prompt_overrides`, finds systematic disagreements ("human consistently overrides KILL → OPTIMIZE when CTR is healthy"), proposes prompt updates. Same approval gate.

**All three loops gated by your approval.** Nothing auto-modifies the system.

---

## 14. Sacred rules — never violate

1. **No action ever executes without human click.** The dashboard suggests; the user approves. Never auto-pause, never auto-kill, never auto-scale — even budget breaches.
2. **The Approve button must refuse to submit if the "expected outcome" field is empty.** Every decision logs a one-line prediction.
3. **Walk all 6 lenses every time.** Never stop early. Each lens contributes — primary cause + contributing factors all shown.
4. **Never touch original tables.** App code references only `dca_*` and `dca_v_*` names.
5. **Forecast = use existing Event Sales Forecasting skill.** Curve-based, 3 scenarios. Never write a linear projection.
6. **Cluster baselines = last resort only.** Always prefer event's own history → direct analogs → affinity siblings before falling back to cluster medians.
7. **Lens 1 always first, Lens 6 always last.** Never let "the market" be the answer until Lenses 1–5 are checked.
8. **The Event Category column on the campaign ledger is the cluster key.** Don't infer category from `marketing_tags` arrays.
9. **Agency rule — no cross-event budget reallocation.** Platinumlist is an agency; each event is funded by its own organizer (Live Nation, Shurooq, etc.). NEVER recommend moving budget between events — that's moving one client's money to another's. Budget reallocation recommendations are allowed ONLY *within* a single event: Meta vs Google, ad set vs ad set, audience vs audience, creative vs creative. If an event is underperforming and within-event optimization can't fix it, the right action is "escalate to human" — never "redirect budget elsewhere in the portfolio."
10. **Security — no keys in code or docs.** Never embed API keys, service-account JSON, Supabase service-role keys, or any secret in `.md` files, comments, README, code strings, or git commits. All secrets go in Vercel env vars (encrypted at rest) / `.env.local` (gitignored). `.gitignore` must block `*service-account*.json`, `gcp-*.json`, `*-credentials*.json`, `*.key.json` (NOT a blanket `*.json` — that catches `package.json`). Never log secret values in console output, error messages, or telemetry. If a key is ever accidentally exposed in git history, rotate it immediately.

---

*Owner: Marketing / Performance. Cadence: daily Watch, Mon/Wed/Fri review sessions. Source of truth for decisions: `dca_decisions` table + `dca_source_b_notes`. Source of truth for the framework: this document.*
