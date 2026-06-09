# Deploy & schedule the `sheet-syncer` Edge Function (v1)

Scheduling is done via the **Supabase Dashboard Cron UI** (Option B). `config.toml`
does **not** support a cron/schedule key, and we deliberately skip the
`pg_cron` + `pg_net` + Vault SQL path to keep v1 friction-free.

The function fetches the campaign-ledger sheet's public CSV export and upserts
into `dca_campaign_ledger` (soft-deletes on absence). No Google credentials —
the sheet is link-shared in v1.

---

## 1. Install + authenticate the CLI (one-time)

```bash
npx supabase login                                   # paste a personal access token
npx supabase link --project-ref kwftlkfvtglnugxsyjci # links to the marketing project
```

## 2. Deploy

```bash
npx supabase functions deploy sheet-syncer
```

`config.toml` sets `verify_jwt = false` for this function, so the deploy makes
it invokable without an auth header.

## 3. Verify env (Dashboard → Edge Functions → sheet-syncer → Settings)

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by the
platform. **No Google / service-account vars needed** (public CSV path).

## 4. Manual sanity invoke (one run)

Dashboard → Edge Functions → `sheet-syncer` → **Invoke** (empty `{}` body), or:

```bash
curl -X POST https://kwftlkfvtglnugxsyjci.supabase.co/functions/v1/sheet-syncer
```

Expected response / log:

```json
{ "ok": true, "synced": 1346, "skipped_empty_event_id": 118,
  "duplicates_collapsed": 20, "soft_deleted": [], "status_unknown_count": 5 }
```

Check **Logs** tab for `sheet-syncer: {"ok":true,...}`.

## 5. Schedule hourly (Dashboard Cron UI)

Dashboard → **Integrations → Cron** (a.k.a. Database → Cron Jobs) → **Create job**:

- **Name:** `sheet-syncer-hourly`
- **Schedule:** `0 * * * *`  (top of every hour)
- **Type:** *Supabase Edge Function*
- **Function:** `sheet-syncer`  · **Method:** `POST`
- Save.

## 6. Confirm the first scheduled run

Within the hour, check Edge Function **Logs** for a fresh `{"ok":true,...}`
entry triggered by the cron job. Once green, **Phase 1b is closed**.

---

## Phase 2 hardening (tracked, not done in v1)

- Sheet → "Specific people" + service-account (Sheets API) instead of public CSV.
- `verify_jwt = true` + an authenticated schedule (Vault-stored service-role key).
