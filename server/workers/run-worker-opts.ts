/*
 * Per-dispatch worker-options parsing for the internal run-worker endpoint
 * (server/api/v1/internal/run-worker/[name].post.ts). Extracted into its own
 * module (rather than living in the route file) so it is unit-testable without
 * booting Nitro and without any route-scanner ambiguity around named exports.
 *
 * The options ride the request BODY, which is inside the signed HMAC payload
 * (server/auth/internal-request.ts — the body-sha256 leg of the signed tuple),
 * so a caller cannot set these flags without a valid signature. No
 * signature-scheme change was needed to make the body a trusted input.
 *
 * Honoured options:
 *  - `deepRescan` (azure-monitor-read) — forces a full-window re-read to recover
 *    a read-path backlog after a silent outage.
 *  - `apply` (privileged-identity-cleanup) — the destructive-apply gate: without
 *    it the cleanup worker only REPORTS; with it (and only via this signed body,
 *    never the UI trigger) it may deactivate excluded teammates, under a hard cap.
 *  - `startingAt` / `endingAt` (analytics-poll) — override the default trailing
 *    30-day revision window with an explicit YYYY-MM-DD span. The operator lever
 *    for the #142 historical re-split: re-pulling a pre-split period rewrites its
 *    collapsed rows as per-surface lanes (the poller's stale-row prune converges
 *    the old collapsed rows). The Enterprise Analytics API holds data from
 *    2026-01-01, so that is the earliest useful startingAt.
 *    OPERATOR WARNING: without `externalOrgId` the override re-pulls the FULL
 *    window for EVERY reconciled org, serially, against the 60-RPM org-wide
 *    Enterprise API cap that reconciliation-sync shares — a multi-month
 *    all-orgs re-pull can run long and starve that worker's tick. Prefer
 *    scoping to one org per invocation.
 *  - `externalOrgId` (analytics-poll) — scope the poll (and therefore a window
 *    override) to ONE reconciled org's external id. Unknown id → clean no-op
 *    (orgsPolled 0), visible in the worker result.
 * Every other worker ignores these. The shape is deliberately generic/optional.
 */
import { readRawBody, type H3Event } from 'h3'
import { z } from 'zod'
import type { WorkerRunContext } from './registry'

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
  .refine((s) => {
    // Calendar-valid, not just shape-valid: 2026-13-40 must fail HERE with a
    // clean validation path, not later as a raw Postgres ::date cast error.
    const [y, m, d] = s.split('-').map(Number)
    const dt = new Date(Date.UTC(y!, m! - 1, d!))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d
  }, 'not a real calendar date')

// Unknown keys are STRIPPED (not rejected) — forward-compatible with a future
// scheduler that sends options this build doesn't know about, and defensive
// against noise.
export const workerOptsSchema = z
  .object({
    deepRescan: z.boolean().optional(),
    apply: z.boolean().optional(),
    startingAt: isoDay.optional(),
    endingAt: isoDay.optional(),
    externalOrgId: z.string().min(1).optional(),
  })
  .strip()

/*
 * Parse the (already-verified, already-read) request body into worker opts.
 *
 * IMPORTANT: verifyInternalRequest already called readRawBody(event) to compute
 * the body-sha256 for signature verification, so h3 has CACHED the raw body on
 * the event (Symbol.for('h3RawBody')). This second readRawBody returns that
 * cached value — it does NOT re-consume the request stream.
 *
 * Fail-soft on EVERY malformation (no body, empty body, non-JSON, wrong shape,
 * a read error): an operator fat-fingering the body must NEVER 500 a scheduled
 * dispatch — it degrades to no-opts (the auto-decided behaviour). Returns
 * undefined when there are no opts, so the endpoint omits `opts` entirely and
 * ctx?.opts stays undefined on the auto path.
 */
export async function parseWorkerOpts(event: H3Event): Promise<WorkerRunContext['opts']> {
  let raw: string | undefined
  try {
    // Default encoding is utf8; returns undefined when there was no body.
    raw = await readRawBody(event)
  } catch {
    return undefined
  }
  if (!raw || raw.trim() === '') return undefined
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  const parsed = workerOptsSchema.safeParse(json)
  if (!parsed.success) return undefined
  // Omit `opts` when it carries nothing (e.g. the body was `{}`) so ctx.opts
  // stays undefined and workers take their auto path unchanged.
  return Object.keys(parsed.data).length > 0 ? parsed.data : undefined
}
