/*
 * Anthropic reconciliation health — validation + live-probe classification for
 * the admin health route (server/api/v1/admin/reconciliation/anthropic/health.get.ts).
 *
 * Two Anthropic reconciliation API variants are selected per-org via
 * provider_org.api_kind (mig 0063):
 *   - 'enterprise-analytics' -> AnthropicEnterpriseClient (DEV). Key scope read:analytics.
 *   - 'claude-code-admin'    -> AnthropicAnalyticsClient (Admin). Key prefix sk-ant-admin01-.
 *
 * SAFETY CONTRACT: this module NEVER returns or logs the API key. It returns only
 * booleans, a which-kind-it-looks-like classification, and a SAFE classified
 * reason. No raw provider error text (which can echo back the key) is surfaced.
 */
import type { AnthropicApiKind } from '../reconciliation/adapters/registry'

/** The unambiguous Admin-key prefix (Claude Code Analytics API). Verified in the
 *  live docs + mig 0063: Admin keys start `sk-ant-admin01-`. */
export const ADMIN_KEY_PREFIX = 'sk-ant-admin01-'

/*
 * Which variant a key's SHAPE looks like — derived from the prefix ALONE, never
 * the body. 'admin' if it carries the Admin prefix; 'analytics' otherwise.
 *
 * NOTE ON THE ENTERPRISE/ANALYTICS PREFIX: the Claude Enterprise Analytics key
 * format is NOT documented in this codebase (no positive prefix to assert). We
 * therefore validate Enterprise keys only NEGATIVELY: an enterprise-analytics
 * org's key must NOT look like an Admin key. We do NOT claim a positive
 * "looks like enterprise-analytics" verdict beyond "not the Admin prefix".
 */
export type KeyShape = 'admin' | 'analytics'

export function classifyKeyShape(key: string): KeyShape {
  return key.startsWith(ADMIN_KEY_PREFIX) ? 'admin' : 'analytics'
}

export type RedReason =
  | 'no-key'
  | 'key-format-mismatch'
  | '400-bad-request'
  | '401-unauthorized'
  | '403-forbidden-scope'
  | '404-wrong-endpoint'
  | 'parse-mismatch'
  | '429-rate-limited'
  | 'endpoint-unset'
  | 'connect-failed'

export type HealthColor = 'green' | 'amber' | 'red'

export interface KeyFormatResult {
  /** true only when the key shape matches the org's api_kind. */
  ok: boolean
  /** Which variant the key SHAPE looks like (prefix-only; never the key body). */
  looksLike: KeyShape
}

/*
 * Validate a key's PREFIX against the org's api_kind. Returns ok=false (a MISMATCH)
 * when:
 *   - api_kind='claude-code-admin' but the key does NOT carry the Admin prefix.
 *   - api_kind='enterprise-analytics' but the key DOES carry the Admin prefix
 *     (an Admin key wired into an Enterprise-Analytics org).
 * The returned `looksLike` is prefix-derived and key-body-free, so it is SAFE to
 * surface. The key itself is never returned.
 */
export function validateKeyFormat(apiKind: AnthropicApiKind, key: string): KeyFormatResult {
  const looksLike = classifyKeyShape(key)
  if (apiKind === 'claude-code-admin') {
    return { ok: looksLike === 'admin', looksLike }
  }
  // enterprise-analytics: must NOT look like an Admin key.
  return { ok: looksLike !== 'admin', looksLike }
}

/*
 * Map a probe result ({ok,status,parsed}) to a SAFE classified red reason, or
 * null when the probe was green (200 + parsed). Status 0 = transport failure.
 */
export function classifyProbe(probe: {
  ok: boolean
  status: number
  parsed: boolean
}): RedReason | null {
  if (probe.ok) return null
  switch (probe.status) {
    case 400:
      // The API REJECTED the request (a malformed/missing param) — distinct from a
      // connection failure. Surfacing it as 'connect-failed' masked a real bug (the
      // missing ending_at). A 400 means "our request was wrong", not "couldn't connect".
      return '400-bad-request'
    case 401:
      return '401-unauthorized'
    case 403:
      return '403-forbidden-scope'
    case 404:
      return '404-wrong-endpoint'
    case 429:
      return '429-rate-limited'
    case 200:
      // Answered but the body was the wrong shape (wrong endpoint / drift).
      return 'parse-mismatch'
    case 0:
      return 'connect-failed'
    default:
      // Any other non-2xx (5xx etc.) is a connect/upstream failure, not an
      // auth/scope verdict — keep it in the safe generic bucket.
      return 'connect-failed'
  }
}

/*
 * The reconciled in-range probe day. Enterprise Analytics + Claude Code data only
 * exist >= 2026-01-01; we probe a RECENT PAST day (yesterday, clamped to not go
 * before the data floor) so the probe is cheap and lands on real data range.
 */
const DATA_FLOOR = '2026-01-01'

export function probeDay(now: Date): string {
  const d = new Date(now.getTime())
  d.setUTCDate(d.getUTCDate() - 1)
  const day = d.toISOString().slice(0, 10)
  return day < DATA_FLOOR ? DATA_FLOOR : day
}

/** RFC-3339 start-of-day for the Enterprise client (it wants a timestamp). */
export function probeStartRfc3339(day: string): string {
  return `${day}T00:00:00Z`
}
