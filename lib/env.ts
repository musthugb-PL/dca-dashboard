/**
 * Server-only environment access for the Campaign Optimisation Dashboard.
 *
 * NEVER import this from a Client Component — every value here is a secret.
 * Validation is lazy (only on access) so the scaffold builds cleanly while
 * keys are still placeholders.
 */

export type EnvKey =
  | "SUPABASE_URL"
  | "SUPABASE_SERVICE_ROLE_KEY"
  | "OPENROUTER_API_KEY"
  | "GCP_BQ_SERVICE_ACCOUNT_JSON";

export const ENV_KEYS: EnvKey[] = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENROUTER_API_KEY",
  "GCP_BQ_SERVICE_ACCOUNT_JSON",
];

const PLACEHOLDER_PREFIX = "replace-me";

/** True when a var is set to a real (non-placeholder) value. */
export function isEnvConfigured(key: EnvKey): boolean {
  const value = process.env[key];
  return (
    value !== undefined &&
    value.length > 0 &&
    !value.startsWith(PLACEHOLDER_PREFIX)
  );
}

/**
 * Read a required env var. Throws a clear, actionable error if it is missing
 * or still a placeholder — but only when actually called, so builds and the
 * blank dashboard work before keys are wired.
 */
export function requireEnv(key: EnvKey): string {
  const value = process.env[key];
  if (!value || value.startsWith(PLACEHOLDER_PREFIX)) {
    throw new Error(
      `Missing env var ${key}. Set it in .env.local (local dev) or in ` +
        `Vercel → Settings → Environment Variables (deploys).`,
    );
  }
  return value;
}
