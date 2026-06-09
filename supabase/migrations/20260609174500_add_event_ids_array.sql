-- Option C: one ledger row per landing page / festival.
-- Primary key stays event_id (the FIRST id in a multi-id cell, backward-compat);
-- the full pipe-delimited list is stored in event_ids[] so the orchestrator can
-- fan out to BQ (id_event IN UNNEST(event_ids)) for aggregated sales later.
alter table dca_campaign_ledger
  add column if not exists event_ids text[];
