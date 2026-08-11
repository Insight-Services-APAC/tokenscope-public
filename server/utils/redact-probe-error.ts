/*
 * redact-probe-error — the ONE place a driver-level probe failure (Postgres,
 * an HTTP reader endpoint, DNS) turns into something safe to put in an HTTP
 * response, modelled on api/health.get.ts:29-37 (same postgres-js driver:
 * "log the real error server-side, return a static string to the caller").
 *
 * WHY THIS EXISTS. A raw `err.message` from postgres-js or Node's network
 * stack routinely carries host, database name, and user (`connect ECONNREFUSED
 * 10.x.x.x:5432`, `password authentication failed for user "app"`) — exactly
 * the topology an unauthenticated-adjacent admin probe must not leak. But this
 * project has ALSO been burned by the opposite failure: a classified
 * "connect-failed" reason masking what was actually a 400 request error (see
 * feedback_classified_errors_mask_raw_cause). So the raw error is NEVER
 * dropped — it goes to the server log at full fidelity, tagged with a
 * correlation id the caller also receives, so an operator with log access can
 * always go from "the page says driver-unreachable, correlation abc123" to
 * the exact underlying error.
 *
 * Never interpolate any fragment of `err.message` (or any other error
 * property) into the returned reason — only the log line gets the raw value.
 */
import { randomUUID } from 'node:crypto'
import { consola } from 'consola'

export type ProbeErrorReason =
  | 'driver-unreachable'
  | 'dns-fail'
  | 'connect-refused'
  | 'auth-denied'
  | 'relation-missing'
  | 'roundtrip-mismatch'
  | 'unknown'

export interface ClassifiedProbeError {
  reason: ProbeErrorReason
  /** Ties this redacted reason back to the full-fidelity line in the server log. */
  correlationId: string
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN'])
const REFUSED_CODES = new Set(['ECONNREFUSED'])
// postgres-js's own connection-lifecycle codes (src/errors.js `connection()`)
// plus the raw Node socket codes it forwards unwrapped on a dead/dropped link.
const UNREACHABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
])
// Postgres SQLSTATE codes (postgres-js's PostgresError carries the server's
// own 5-char code in `.code`): 28P01 invalid_password, 28000
// invalid_authorization_specification.
const AUTH_DENIED_CODES = new Set(['28P01', '28000'])
// 42P01 undefined_table, 3D000 invalid_catalog_name (database absent) — both
// "the thing this probe expected to read is not there".
const RELATION_MISSING_CODES = new Set(['42P01', '3D000'])

function codeOf(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code?: unknown }).code
    if (typeof c === 'string') return c
  }
  return undefined
}

function classify(err: unknown): ProbeErrorReason {
  const code = codeOf(err)
  if (!code) return 'unknown'
  if (DNS_CODES.has(code)) return 'dns-fail'
  if (REFUSED_CODES.has(code)) return 'connect-refused'
  if (UNREACHABLE_CODES.has(code)) return 'driver-unreachable'
  if (AUTH_DENIED_CODES.has(code)) return 'auth-denied'
  if (RELATION_MISSING_CODES.has(code)) return 'relation-missing'
  return 'unknown'
}

/**
 * Classify a caught probe error into a safe reason code, logging the raw
 * error server-side at full fidelity under a correlation id the caller gets
 * back too. `context` is a short, static label (e.g.
 * `'diagnostics:postgres'`) identifying WHICH probe failed — it is a
 * hardcoded string at each call site, never derived from request input.
 */
export function classifyProbeError(err: unknown, context: string): ClassifiedProbeError {
  const correlationId = randomUUID()
  consola.error(`[probe-error:${context}] ${correlationId}`, err instanceof Error ? err : String(err))
  return { reason: classify(err), correlationId }
}
