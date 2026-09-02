/*
 * probe-error-reason — the CLOSED vocabulary a classified probe failure may be
 * reported as. Split out of server/utils/redact-probe-error.ts (which still
 * re-exports the type, so every existing importer is unchanged) for two
 * reasons:
 *
 *   1. `shared/` cannot import from `server/`, and the ops-alert reason union
 *      (shared/ops-alert/conditions.ts, docs/design/alert-diagnosability.md D1)
 *      is defined as a union WITH this type rather than a second copy of its
 *      members. A copy would drift the moment a new driver code is classified.
 *   2. The membership check has to exist at RUNTIME, not only in the type
 *      system: `ReaderHealth.error` is EITHER one of these codes (a caught
 *      exception, redacted) or a status string like `HTTP 404` /
 *      `query status=Failure`. Only the former may enter a closed union, so a
 *      caller needs to ask.
 *
 * The classifier itself, and the full-fidelity server-side logging that makes
 * redaction lossless, stay in server/utils/redact-probe-error.ts — they need
 * node:crypto and consola and are server concerns. This file is vocabulary only.
 */

/** Every reason `classifyProbeError` can return. */
export const PROBE_ERROR_REASONS = [
  'driver-unreachable',
  'dns-fail',
  'connect-refused',
  'auth-denied',
  'relation-missing',
  /**
   * The statement did not finish inside the budget it was given: either the
   * server cancelled it (SQLSTATE 57014, a `statement_timeout` a probe set on
   * its own transaction) or the caller's race gave up first. Distinct from
   * 'driver-unreachable': the connection was fine and the server answered — the
   * WORK was too slow, which is a different fix. Without it a bounded probe
   * reports its own bound as 'unknown', which is the uninformative-by-
   * construction shape this vocabulary exists to avoid.
   */
  'statement-timeout',
  'roundtrip-mismatch',
  'unknown',
] as const

export type ProbeErrorReason = (typeof PROBE_ERROR_REASONS)[number]

const MEMBERS: ReadonlySet<string> = new Set(PROBE_ERROR_REASONS)

/** Whether an arbitrary value is one of the classified reasons (never free text). */
export function isProbeErrorReason(value: unknown): value is ProbeErrorReason {
  return typeof value === 'string' && MEMBERS.has(value)
}
