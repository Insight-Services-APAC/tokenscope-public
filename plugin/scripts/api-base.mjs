/*
 * Resolve the TokenScope API base URL.
 *
 * The API base is PART OF THE PLUGIN, not a user-managed env var: the plugin
 * ships from a specific deployment's marketplace, so it already implies its
 * server. Resolution order:
 *   1. TOKENSCOPE_API_BASE env  — override only (local dev: http://localhost:3450,
 *      or pointing at another instance).
 *   2. explicit arg             — e.g. an enrol invocation may pass the base.
 *   3. DEFAULT_API_BASE         — the baked deployment URL (below).
 *
 * The marketplace serves the plugin straight from the repo (no build step), so
 * the default is committed here. It's a public hostname, not a secret.
 *
 * DEFAULT_API_BASE is the GBS Dev environment's stable custom domain
 * (tokenscope.example.com, behind IT's WAF) — the dogfood + pilot target as
 * of 2026-06-17, superseding the old sandbox Front Door host. A custom domain is
 * used deliberately (the random *.azurefd.net suffix regenerates if the endpoint
 * is recreated). The OTLP ingestion endpoint, bearer endpoint and emit credential
 * are NOT baked here — they are returned by THIS deployment's server at provision
 * time (server/auth/emit-provision.ts), so pointing at dev is the whole switch.
 * Sandbox stays reachable via the TOKENSCOPE_API_BASE override.
 */
export const DEFAULT_API_BASE = 'https://tokenscope.example.com'

/** Resolve the API base (env override > arg > baked default), trailing slash stripped. */
export function resolveApiBase(argBase) {
  // Trim BOTH the env and the arg: a whitespace-only TOKENSCOPE_API_BASE (e.g. a
  // fat-fingered `export`) is truthy and would otherwise become a garbage base.
  const raw = (process.env.TOKENSCOPE_API_BASE || '').trim() || (argBase ?? '').trim() || DEFAULT_API_BASE
  return raw.replace(/\/+$/, '')
}
