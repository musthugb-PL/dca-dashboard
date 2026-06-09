/**
 * BigQuery client for the Campaign Optimisation Dashboard.
 *
 * Primary read warehouse (read-only via service account). See CLAUDE.md
 * "CRITICAL ALIGNMENT RULE" — this is the source of truth for spend /
 * impressions / clicks / sales / funnel. Reads from project
 * `platinumlist-1014`, dataset `ai_dataset`.
 *
 * SERVER-ONLY. Never import from a Client Component — the credential is a
 * secret. The key is read from GCP_BQ_SERVICE_ACCOUNT_JSON (Vercel env var
 * in prod; .env.local for local dev — both gitignored). Sacred Rule #10:
 * no key value is ever embedded here, logged, or echoed.
 */

import { BigQuery } from "@google-cloud/bigquery";
import { requireEnv } from "./env";

/** Query target — fixed per CLAUDE.md / data map. */
export const BQ_PROJECT = "platinumlist-1014";
export const BQ_DATASET = "ai_dataset";

type ServiceAccount = {
  client_email?: string;
  private_key?: string;
  project_id?: string;
  [key: string]: unknown;
};

/**
 * Accept EITHER raw service-account JSON OR a base64-encoded blob in
 * GCP_BQ_SERVICE_ACCOUNT_JSON, and auto-detect which. This means the value
 * works whether it was pasted raw or base64-encoded — no manual encoding
 * step required.
 *
 * Detection order:
 *   1. Looks like JSON (starts with "{") → parse directly.
 *   2. Otherwise → treat as base64, decode, then parse.
 *   3. If base64-decode-then-parse fails, fall back to a direct parse so the
 *      error message points at the real problem.
 */
function parseServiceAccount(value: string): ServiceAccount {
  const trimmed = value.trim();

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as ServiceAccount;
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    return JSON.parse(decoded) as ServiceAccount;
  } catch {
    // Not valid base64-encoded JSON — try a direct parse so the thrown
    // error describes the actual malformed input (without echoing it).
    return JSON.parse(trimmed) as ServiceAccount;
  }
}

let client: BigQuery | null = null;

/** Lazily construct a singleton BigQuery client. */
function getClient(): BigQuery {
  if (client) return client;

  const credentials = parseServiceAccount(
    requireEnv("GCP_BQ_SERVICE_ACCOUNT_JSON"),
  );

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error(
      "GCP_BQ_SERVICE_ACCOUNT_JSON is missing client_email / private_key. " +
        "Check the service-account key is complete (raw JSON or base64).",
    );
  }

  client = new BigQuery({
    projectId: BQ_PROJECT,
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key,
    },
  });

  return client;
}

/** Optional named query parameters, e.g. { eventId: 105811, day: "2026-06-04" }. */
export type QueryParams = Record<string, unknown>;

/**
 * Run a SQL query and return typed rows.
 *
 * @example
 *   const rows = await bq.query<{ n: number }>(
 *     "SELECT COUNT(*) AS n FROM `platinumlist-1014.ai_dataset.completed_orders`"
 *   );
 *
 * @example with named params (preferred for any dynamic value):
 *   await bq.query(
 *     "SELECT * FROM `...completed_orders` WHERE event_id = @eventId",
 *     { eventId: 105811 }
 *   );
 */
export const bq = {
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
  ): Promise<T[]> {
    const [rows] = await getClient().query({
      query: sql,
      location: "US",
      ...(params ? { params } : {}),
    });
    return rows as T[];
  },
};
