/*
 * org-units DB helpers — shared validation used across the admin endpoints.
 *
 * assertOrgUnitInRegion centralises the repeated "the supplied org_unit_id
 * must be an org unit in this region" guard. Several endpoints duplicated the
 * same SELECT-then-422 shape:
 *   - projects.post.ts (cost-owning unit) — does NOT require active.
 *   - projects/[id].patch.ts (cost-owning unit) — requires active.
 *   - teammates.post.ts (placement org unit) — requires active.
 *   - users/[id]/org-unit.patch.ts (intra-region move) — requires active.
 *
 * Pass mustBeActive to add the `AND retired_at IS NULL` clause; each call site
 * keeps its own statusMessage so the existing error text is unchanged.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { createError } from 'h3'

export interface AssertOrgUnitInRegionOpts {
  orgUnitId: string
  regionId: string
  mustBeActive: boolean
  statusMessage?: string
  /*
   * Optional RFC-9457 Problem-Details body. Two call sites attach one (the
   * client reads `err.data.data.detail`); pass it through verbatim so the
   * surfaced message is unchanged after the dedup.
   */
  data?: Record<string, unknown>
}

export async function assertOrgUnitInRegion(
  tx: PostgresJsDatabase<Record<string, unknown>>,
  opts: AssertOrgUnitInRegionOpts,
): Promise<void> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM org_unit
    WHERE id = ${opts.orgUnitId}::uuid
      AND region_id = ${opts.regionId}::uuid
      ${opts.mustBeActive ? sql`AND retired_at IS NULL` : sql``}
    LIMIT 1
  `)
  if (![...rows][0]) {
    throw createError({
      statusCode: 422,
      statusMessage: opts.statusMessage ?? 'org_unit_id is not a valid org unit in this region',
      ...(opts.data ? { data: opts.data } : {}),
    })
  }
}
