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
 * Every other worker ignores both. The shape is deliberately generic/optional.
 */
import { readRawBody, type H3Event } from 'h3'
import { z } from 'zod'
import type { WorkerRunContext } from './registry'

// Unknown keys are STRIPPED (not rejected) — forward-compatible with a future
// scheduler that sends options this build doesn't know about, and defensive
// against noise. Each flag must be a real boolean.
export const workerOptsSchema = z
  .object({ deepRescan: z.boolean().optional(), apply: z.boolean().optional() })
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
