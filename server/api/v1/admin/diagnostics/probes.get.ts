/*
 * GET /api/v1/admin/diagnostics/probes — the network-bound half of the
 * diagnostics snapshot: `services` (TCP reachability of every provisioned
 * private endpoint — the SAME probe the entrypoint pre-flight runs at boot)
 * and `telemetryRead` (a bounded read of the telemetry query path through the
 * configured reader: DNS → the (private) query endpoint + token acceptance —
 * LAW can't be meaningfully TCP-probed; its public frontend would mislead).
 *
 * Split out of GET /diagnostics (docs/design/admin-nav-responsiveness.md D4)
 * so the DB-only snapshot answers in the hundreds of milliseconds while the
 * page draws this card's skeleton until the probes land. Both probes run
 * concurrently, each raced against PROBE_BUDGET_MS with the ops-alert
 * `boundedCall` shape (server/workers/ops-alert.ts): the losing promise is
 * abandoned, and the probe reports its failed shape. Nothing here throws past
 * the role gate, and nothing here reads a table — there is no RLS lane to
 * carry, and no direct database handle is acquired. (Do not name the raw
 * db accessor in this comment: scripts/check-handler-rls-context.mjs scans
 * raw source, so a mention alone fails the guard.)
 *
 * RBAC: admin / global-finops (the gate of the snapshot this was cut from).
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { getTelemetryReader, type ReaderHealth } from '../../../../azure/reader'
import { classifyProbeError } from '../../../../utils/redact-probe-error'
// Canonical probe module — also run at boot by the entrypoint pre-flight.
// Lives in scripts/ (raw in the runtime image); nitro bundles it here at build.
import { probeServices, resolveServices, type ServiceProbe } from '../../../../../scripts/preflight'

/*
 * The outer race, per probe. Short (5 s, incl. boot-critical services) for an
 * INTERACTIVE page — the 30 s critical default is for boot, not a human-facing
 * request that must not hang on a wedged endpoint.
 */
const PROBE_BUDGET_MS = 5000
/*
 * The per-socket TCP timeout sits UNDER the race so probeServices settles on
 * its own: one hung endpoint then reports as ITS OWN timeout row while the
 * others keep their real answers. Were the two equal, the race would fire
 * first by a hair and every service would read unanswered.
 */
const TCP_PROBE_TIMEOUT_MS = 4000

type TelemetryReadResult =
  | ReaderHealth
  | { ok: false; kind: 'unknown'; latencyMs: null; error: string; correlationId: string }

type BoundedOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; timedOut: boolean; error: unknown }

/** The error a probe that overran its budget is classified and logged as. */
function budgetExceeded(ms: number): Error & { code: string } {
  return Object.assign(new Error(`probe exceeded its ${ms} ms budget`), { code: 'ETIMEDOUT' })
}

/*
 * Race a probe against its budget. The losing promise is left pending on
 * purpose — abandoning a hung probe is the point (one card degrades; the
 * request never does).
 */
async function boundedCall<T>(fn: () => Promise<T>, ms: number): Promise<BoundedOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn().then((value) => ({ ok: true as const, value })),
      new Promise<BoundedOutcome<T>>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, timedOut: true, error: budgetExceeded(ms) }), ms)
      }),
    ])
  } catch (err) {
    return { ok: false, timedOut: false, error: err }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The services list when the probe as a whole did not answer: every resolved
 * endpoint reads unreachable with the class the probe would have given it, so
 * the card goes red instead of showing an empty "no probes reported".
 */
function servicesUnanswered(errorClass: 'timeout' | 'other', error: string): ServiceProbe[] {
  return resolveServices(process.env).map((s) =>
    s.endpoint
      ? {
          name: s.name,
          critical: s.critical,
          status: 'unreachable',
          target: `${s.endpoint.host}:${s.endpoint.port}`,
          latencyMs: null,
          errorClass,
          error,
        }
      : { name: s.name, critical: s.critical, status: 'skipped', target: null, latencyMs: null, reason: s.reason },
  )
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')

  const [servicesOutcome, telemetryOutcome] = await Promise.all([
    boundedCall(() => probeServices(process.env, TCP_PROBE_TIMEOUT_MS, TCP_PROBE_TIMEOUT_MS), PROBE_BUDGET_MS),
    // The reader's own timeoutMs bounds the query (abort signal + server-side
    // budget); the outer race additionally covers what that cannot reach — a
    // wedged SDK import, credential chain or DNS lookup before the request.
    boundedCall(() => getTelemetryReader().healthCheck({ timeoutMs: PROBE_BUDGET_MS }), PROBE_BUDGET_MS),
  ])

  const services: ServiceProbe[] = servicesOutcome.ok
    ? servicesOutcome.value
    : servicesUnanswered(
        servicesOutcome.timedOut ? 'timeout' : 'other',
        // Never the raw message: the classifier logs it under a correlation id.
        servicesOutcome.timedOut ? 'ETIMEDOUT' : classifyProbeError(servicesOutcome.error, 'diagnostics:services').reason,
      )

  const telemetryRead: TelemetryReadResult = telemetryOutcome.ok
    ? telemetryOutcome.value
    : (() => {
        // Same shape the old in-snapshot try/catch produced: an unconfigured
        // reader (getTelemetryReader throws), a reader that threw, or a probe
        // that overran its budget all land here with a classified reason.
        const { reason, correlationId } = classifyProbeError(telemetryOutcome.error, 'diagnostics:telemetry-read')
        return { ok: false, kind: 'unknown', latencyMs: null, error: reason, correlationId }
      })()

  return { services, telemetryRead }
})
