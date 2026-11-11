/*
 * GET /api/v1/me/instances — the developer's own enrolled instances
 * (devices), per ADR-0005 decision 3 ("Spot + block from the web app",
 * dev: own).
 *
 * Owner-scoping is the live gate: every row is bounded to
 * `instance_attestation.teammate_id = session.teammateId`. RLS is inert
 * under the owner DB connection (see request-rls.ts), so this app-level
 * predicate — NOT RLS — is what stops a dev seeing a peer's device.
 *
 * Per instance:
 *   - instance_id, tool, ts_start, ts_actual_end
 *   - revoked     — ts_actual_end IS NOT NULL (joiner/bearer then skip it)
 *   - last_emission — MAX(attribution_record.ts_event) for this instance
 *   - spend_usd_mtd — SUM(cost_usd) this calendar month for this instance
 *   - project     — raw_project_code (nullable; unassigned enrolment)
 *   - state       — sending, idle, not-in-use, cannot-send or revoked, decided
 *                   in the shared projection (instance-projection.ts, #592).
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { requestClock } from '../../../utils/request-clock'
import {
  instanceMetricColumns,
  instanceProjectionWindow,
  projectInstanceRow,
  type InstanceMetricRow,
} from '../../../utils/instance-projection'

const Query = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
})

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const query = await getValidatedQuery(event, (data) => Query.parse(data))
  const window = instanceProjectionWindow(new Date(requestClock(event).now))

  const rows = await withRequestRls(event, async (tx) =>
    tx.execute<InstanceMetricRow & Record<string, unknown>>(sql`
      SELECT
        ia.instance_id::text                                        AS instance_id,
        ia.tool                                                     AS tool,
        ia.display_name                                             AS display_name,
        ia.raw_project_code                                         AS raw_project_code,
        ia.ts_start::text                                           AS ts_start,
        ia.ts_actual_end::text                                      AS ts_actual_end,
        ${instanceMetricColumns(window.monthStartIso)}
      FROM instance_attestation ia
      WHERE ia.teammate_id = ${session.teammateId}::uuid
      ORDER BY ia.ts_start DESC
      LIMIT ${query.limit} OFFSET ${query.offset}
    `),
  )

  return {
    instances: [...rows].map((r) => projectInstanceRow(r, window)),
  }
})
