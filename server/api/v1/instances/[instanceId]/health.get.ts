/*
 * GET /api/v1/instances/{instanceId}/health — the device's OWN delivery health.
 *
 * Emit-credential authed (the SAME gate as /bearer: requireOAuthBearer
 * 'tokenscope.emit' + ownership), so a device can self-check "did my telemetry
 * actually LAND?" with the credential it already has — no MCP/read auth needed.
 * Read-only and narrow: returns only THIS instance's own last-landed timestamp +
 * bearer heartbeat, never another instance and never any cross-teammate corpus —
 * so the read↔emit wall holds (this is a device reading its own delivery beacon,
 * not the telemetry corpus).
 *
 * `last_emission = MAX(attribution_record.ts_event)` for this instance — i.e. a real
 * record the read-joiner has landed + processed. Null until the read path delivers.
 * The plugin caches this so the statusline can show a real green `✓ landed`.
 */
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb, schema } from '../../../../db'
import { requireOAuthBearer } from '../../../../auth/oauth-bearer'
import { SILENT_AFTER_HOURS } from '../../../../utils/instance-projection'

const SidSchema = z.string().uuid()

export default defineEventHandler(async (event) => {
  const parsed = SidSchema.safeParse(getRouterParam(event, 'instanceId'))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid instance id' })
  }
  const sid = parsed.data
  const db = getDb()

  // Same auth as /bearer — the emit credential, scope-checked + revocation-
  // checked, AND now instance-bound (a different instance's emit credential
  // 401s here instead of degrading to a per-teammate check).
  const teammate = await requireOAuthBearer(event, 'tokenscope.emit', db as never, sid)

  const [row] = await db
    .select({
      instanceId: schema.instanceAttestation.instanceId,
      teammateId: schema.instanceAttestation.teammateId,
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
  const aggRows = await db.execute<{ last_emission: string | null }>(sql`
    SELECT MAX(ar.ts_event)::text AS last_emission
      FROM attribution_record ar
     WHERE ar.instance_id = ${sid}::uuid
  `)
  const lastEmission = [...aggRows][0]?.last_emission ?? null

  const lastMs = lastEmission ? Date.parse(lastEmission) : null
  const revoked = row.tsActualEnd != null
  const silentCutoffMs = Date.now() - SILENT_AFTER_HOURS * 60 * 60_000
  const silent = !revoked && (lastMs === null || lastMs < silentCutoffMs)

  return {
    instance_id: sid,
    last_emission: lastEmission,
    last_bearer_at: row.lastBearerAt ? row.lastBearerAt.toISOString() : null,
    silent,
    revoked,
  }
})
