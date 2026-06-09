-- Hourly schedule for the sheet-syncer Edge Function (pg_cron + pg_net).
-- Run once in the SQL editor of project kwftlkfvtglnugxsyjci after deploy.
-- Requires the `pg_cron` and `pg_net` extensions (enable in Database → Extensions).
--
-- Replace <PROJECT_REF> with kwftlkfvtglnugxsyjci and supply the service-role
-- key via a Vault secret or the dashboard — never hard-code it in committed SQL.

select
  cron.schedule(
    'sheet-syncer-hourly',
    '0 * * * *', -- top of every hour
    $$
    select net.http_post(
      url    := 'https://<PROJECT_REF>.supabase.co/functions/v1/sheet-syncer',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body := '{}'::jsonb
    );
    $$
  );

-- To remove:  select cron.unschedule('sheet-syncer-hourly');
