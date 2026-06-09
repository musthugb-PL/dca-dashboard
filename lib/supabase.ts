/**
 * Server-only Supabase client for the marketing project
 * (kwftlkfvtglnugxsyjci). Uses the SERVICE-ROLE key — bypasses RLS, so this
 * must NEVER be imported from a Client Component.
 *
 * Per CLAUDE.md / data map: app code reads ONLY `dca_*` (writeable) and
 * `dca_v_*` (read-only views). Never reference original tables by name.
 *
 * Sacred Rule #10: the key value is read from env only — never embedded,
 * logged, or echoed here.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env";

let client: SupabaseClient | null = null;

/** Lazily construct a singleton service-role client. */
export function getSupabase(): SupabaseClient {
  if (client) return client;
  client = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return client;
}
