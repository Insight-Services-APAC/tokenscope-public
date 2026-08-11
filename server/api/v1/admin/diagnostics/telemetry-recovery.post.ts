/*
 * POST /api/v1/admin/diagnostics/telemetry-recovery — enqueue a WIDENED RE-READ.
 *
 * THE GAP THIS CLOSES. server/azure/reader.ts honours `lookbackDays` (default 7,
 * max 90) — the lever that reaches already-ingested telemetry older than a week
 * and re-joins it. It was reachable only through a signed HMAC worker body
 * (`azure-monitor-read` is deliberately not UI-triggerable, and no UI passed
 * worker opts). So a backlog older than seven days could not be recovered from the
 * product at all, and a signed re-run WITHOUT the lever recovers seven days while
 * reporting success indistinguishably from a full recovery.
 *
 * WHY THIS IS NOT "ADD azure-monitor-read TO UI_TRIGGERABLE_WORKER_NAMES". That
 * safelist's contract is idempotent workers an admin may force AT THEIR DEFAULTS;
 * adding the joiner wholesale would put the fleet-wide scheduled selection behind
 * a one-click button, which is exactly the blast radius the list withholds. This
 * exposes something strictly narrower — a re-read SCOPED to named instances at a
 * stated window — and does it as an RBAC'd, same-origin-checked, audited request.
 *
 * WHY IT ENQUEUES INSTEAD OF RUNNING. The run-worker HTTP path sits behind a ~120s
 * gateway; a 90-day read across a set of instances will exceed it, and the handler
 * keeps running while holding the single-flight lock so later calls 409. The
 * telemetry-recovery worker drains this queue in resumable slices (mig 0093),
 * exactly as reconciliation-backfill does for provider pulls. Nothing here runs
 * long, so nothing here can 504.
 *
 * RBAC: requireRole('global-finops') + assertSameOrigin, matching
 * /admin/workers/{name}/run rather than the region-scoped `admin` tier. Two
 * reasons: the recovery operates across instances irrespective of region (a
 * region-scoped admin passing another region's instance id would otherwise exceed
 * their scope), and it spends real Log Analytics query budget. The READ side of
 * this feature (the attribution-gap list and the instance-telemetry
 * discriminator) stays at the wider admin tier — see those handlers.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { readValidated } from '../../../../utils/validated-body'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { translatePgConstraintError } from '../../../../utils/pg-constraint-error'
import { telemetryRecoveryRequest } from '../../../../../drizzle/schema'

/*
 * Campaign size cap. Larger than run-worker-opts.ts's MAX_WIDENED_BATCH (50)
 * on purpose: that number bounds ONE synchronous signed invocation against the
 * gateway ceiling, whereas this bounds a CAMPAIGN that the worker drains five
 * instances at a time across as many ticks as it needs. The cap that matters here
 * is human — a recovery you cannot reason about is not a recovery.
 */
const MAX_INSTANCES = 200

const Body = z.object({
  instanceIds: z.array(z.string().uuid()).min(1).max(MAX_INSTANCES),
  /*
   * Bounded to the reader's own MAX_LOOKBACK_DAYS (90 = the longest retention we
   * provision). The reader clamps too, and the table has a CHECK — three layers,
   * because a silently-narrowed window is the failure mode this whole endpoint
   * exists to make impossible.
   */
  lookbackDays: z.number().int().min(1).max(90),
  /** Operator's note. Recorded on the row and in the audit event. */
  // .min(1) AFTER .trim(): optional is fine (no note given), but a note made
  // entirely of whitespace is worse than none — it renders as a populated
  // reason in the audit trail and the queue row while carrying nothing, so a
  // reader cannot tell "no reason recorded" from "reason recorded, unreadable".
  reason: z.string().trim().min(1).max(500).optional(),
})

function badRequest(detail: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: 'Invalid recovery request',
    data: {
      type: 'https://tokenscope.example.com/errors/validation',
      title: 'Invalid recovery request',
      status: 400,
      detail,
    },
  })
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'global-finops')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  // De-duplicate while preserving the caller's order: the worker consumes the
  // array positionally, so a repeated id would be re-read (harmless — the joiner
  // dedups) but would also consume budget and inflate instances_processed, making
  // the progress figure lie about how much of the fleet was covered.
  const instanceIds = [...new Set(body.instanceIds)]

  return await withRequestRls(event, async (tx) => {
    // Reject unknown ids rather than accepting them: the joiner silently skips an
    // id it cannot resolve, so a typo would produce a request that runs to
    // 'succeeded' having recovered nothing, which is precisely the false-green
    // this feature exists to eliminate.
    const known = await tx.execute<{ instance_id: string }>(sql`
      SELECT instance_id::text AS instance_id
        FROM instance_attestation
       WHERE instance_id IN (${sql.join(instanceIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `)
    const knownSet = new Set([...known].map((r) => r.instance_id))
    const unknown = instanceIds.filter((id) => !knownSet.has(id))
    if (unknown.length > 0) {
      badRequest(
        `these instance ids do not exist, so a recovery scoped to them would report success having read nothing: ${unknown
          .slice(0, 5)
          .join(', ')}${unknown.length > 5 ? ` (+${unknown.length - 5} more)` : ''}`,
      )
    }

    // One in-flight recovery GLOBALLY — a widened read is the most expensive
    // request we make of Log Analytics, and two concurrent campaigns would contend
    // for the same budget while both reporting progress. The partial unique index
    // (mig 0093) is the TOCTOU backstop for this pre-check.
    const inflight = await tx.execute<{ id: string; status: string }>(sql`
      SELECT id::text AS id, status FROM telemetry_recovery_request
       WHERE status IN ('pending', 'running') LIMIT 1
    `)
    const busy = [...inflight][0]
    if (busy) {
      throw createError({
        statusCode: 409,
        statusMessage: 'A telemetry recovery is already in flight',
        data: {
          type: 'https://tokenscope.example.com/errors/conflict',
          title: 'A telemetry recovery is already in flight',
          status: 409,
          detail: `Recovery ${busy.id} is ${busy.status}. Wait for it to finish — widened reads are run one at a time so they cannot contend for query budget.`,
        },
      })
    }

    let created: { id: string } | undefined
    try {
      ;[created] = await tx
        .insert(telemetryRecoveryRequest)
        .values({
          instanceIds,
          lookbackDays: body.lookbackDays,
          reason: body.reason ?? null,
          requestedBy: caller.teammateId,
        })
        .returning({ id: telemetryRecoveryRequest.id })
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23505': {
          status: 409,
          title: 'A telemetry recovery is already in flight',
          detail: 'Another recovery was enqueued concurrently. Wait for it to finish and retry.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'telemetry-recovery-requested',
      actorTeammateId: caller.teammateId,
      subjectKind: 'telemetry-recovery',
      subjectId: created!.id,
      payload: {
        instance_count: instanceIds.length,
        instance_ids: instanceIds,
        lookback_days: body.lookbackDays,
        reason: body.reason ?? null,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: created!.id,
      status: 'pending',
      instanceCount: instanceIds.length,
      lookbackDays: body.lookbackDays,
      // Say plainly that acceptance is not completion. The whole class of bug
      // behind this feature is a 2xx being read as "the work happened".
      note: 'Enqueued. The telemetry-recovery worker drains it in resumable slices; poll this endpoint (GET) for progress. Accepted does not mean recovered.',
    }
  })
})
