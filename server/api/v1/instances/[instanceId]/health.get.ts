/*
 * GET /api/v1/instances/{instanceId}/health — the device's OWN delivery health.
 *
 * Emit-credential authed (the SAME gate as /bearer: requireOAuthBearer
 * 'tokenscope.emit' + ownership), so a device can self-check "did my telemetry
 * actually LAND?" with the credential it already has — no MCP/read auth needed.
 * Read-only and narrow: returns only THIS instance's own last-landed timestamp +
 * bearer heartbeat + its own enrolment start (`ts_start`, so a client can age a
 * never-landed enrolment), never another instance and never any cross-teammate corpus —
 * so the read↔emit wall holds (this is a device reading its own delivery beacon,
 * not the telemetry corpus).
 *
 * `last_emission = MAX(attribution_record.ts_event)` for this instance — i.e. a real
 * record the read-joiner has landed + processed. Null until the read path delivers.
 * The plugin caches this so the statusline can show a real green `✓ landed`.
 *
 * LANE: machine (docs/design/rls-enforcement.md §2). There is no cookie session
 * here, so `withRequestRls` cannot serve it — the emit credential resolves the
 * identity instead, and `withMachineRls` carries it onto the connection. The
 * `attribution_record` read below is a PHASE-1 FORCE table: without a context it
 * would return NULL rather than error, and every device would report a
 * permanently-silent `last_emission`.
 */
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb, schema } from '../../../../db'
import { withMachineRls } from '../../../../db/machine-rls'
import { requireOAuthBearer } from '../../../../auth/oauth-bearer'
import { SILENT_AFTER_HOURS } from '../../../../utils/instance-projection'

const SidSchema = z.string().uuid()

export default defineEventHandler(async (event) => {
  const parsed = SidSchema.safeParse(getRouterParam(event, 'instanceId'))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid instance id' })
  }
  const sid = parsed.data

  // Same auth as /bearer — the emit credential, scope-checked + revocation-
  // checked, AND now instance-bound (a different instance's emit credential
  // 401s here instead of degrading to a per-teammate check). This lookup is the
  // BOOTSTRAP and necessarily runs before any identity exists, on `oauth_token`
  // — which is in server/db/rls-bootstrap.ts::RLS_BOOTSTRAP_TABLES and DISABLEd at cutover for that reason. Omission from a
  // FORCE phase would not help: ENABLE alone filters a non-owner.
  const teammate = await requireOAuthBearer(event, 'tokenscope.emit', getDb() as never, sid)

  const { row, lastEmission } = await withMachineRls(teammate, async (tx) => {
    const [row] = await tx
      .select({
        instanceId: schema.instanceAttestation.instanceId,
        teammateId: schema.instanceAttestation.teammateId,
        tsStart: schema.instanceAttestation.tsStart,
        tsActualEnd: schema.instanceAttestation.tsActualEnd,
        lastBearerAt: schema.instanceAttestation.lastBearerAt,
      })
      .from(schema.instanceAttestation)
      .where(eq(schema.instanceAttestation.instanceId, sid))
      .limit(1)

    // Not-found AND not-owned collapse to the SAME 404 (mirrors /bearer and
    // me/instances/[instanceId]/revoke.post.ts) — don't let a 403 distinguish
    // "exists but isn't yours" from "doesn't exist".
    if (!row || !row.teammateId || row.teammateId !== teammate.teammateId) {
      throw createError({ statusCode: 404, statusMessage: 'Instance not found' })
    }

    // last_emission = MAX(attribution_record.ts_event) for THIS instance — the same
    // landed metric /me/instances projects (instance-projection.ts).
    const aggRows = await tx.execute<{ last_emission: string | null }>(sql`
      SELECT MAX(ar.ts_event)::text AS last_emission
        FROM attribution_record ar
       WHERE ar.instance_id = ${sid}::uuid
    `)
    return { row, lastEmission: [...aggRows][0]?.last_emission ?? null }
  })

  const lastMs = lastEmission ? Date.parse(lastEmission) : null
  const revoked = row.tsActualEnd != null
  const silentCutoffMs = Date.now() - SILENT_AFTER_HOURS * 60 * 60_000
  const silent = !revoked && (lastMs === null || lastMs < silentCutoffMs)

  return {
    instance_id: sid,
    last_emission: lastEmission,
    last_bearer_at: row.lastBearerAt ? row.lastBearerAt.toISOString() : null,
    // ENROLMENT AGE. Additive (older plugins ignore it). Without this a client
    // cannot tell a 90-second-old enrolment whose first record is still in flight
    // from one enrolled hours ago that has NEVER landed — both are
    // `last_emission: null`. The first is normal; the second is a fault. The
    // statusline needs the difference to stop rendering the second as benign.
    ts_start: row.tsStart.toISOString(),
    silent,
    revoked,
  }
})
