/*
 * GET /api/v1/projects/{id}/consumption — month-to-date consumption
 * total for a project, irrespective of the caller's assignment.
 *
 * Used by the allocator editor's ConsumptionCard so managers viewing
 * a project they aren't assigned to still see real numbers (rather
 * than $0 from a /me-scoped fetch).
 *
 * ONE LANE. The figure comes from `completeProjectSpend`
 * (server/usage/complete-spend.ts) — the same call, window and
 * `excludeProvisional` option the project page and the budget alert make.
 * It used to be a bespoke `SUM(attribution_record.cost_usd)` here, which
 * meant "Manage budget →" walked the PM from the project page's number to a
 * DIFFERENT one at the exact moment they decided whether to extend, and both
 * were blind to the reconciled (arm 2) spend that the alert already counted.
 *
 * Scope: managers see consumption only for projects whose
 * cost_owning_unit is within their org subtree (app.user_org_path); a
 * region `admin` is bounded to the project's region via
 * requireRegionScope (API-1 — the same requireRegionScope pattern the
 * admin/* endpoints apply); global-finops /
 * platform-admin are unbounded. This app-level clamp is the live gate —
 * RLS is bypassed at runtime (owner DB connection) until Epic 10's
 * non-owner role lands, so we cannot lean on the attribution_record
 * policy here. Same rationale as server/auth/allocation-scope.ts. An
 * out-of-subtree project id returns 0 (no row) for a manager, never
 * another org's sum.
 *
 * S3: the in-query clause is orgSubtreeScopePredicate('cou') — the SAME
 * region-clamp + placedBelowRegionRootPredicate() gate every other
 * subtree-scoped surface uses, replacing a hand-rolled `role IN
 * ('admin','global-finops') OR cou.path <@ …` that carried NO region term
 * (org_unit paths are only unique per-region, so a manager's path could
 * collide with a foreign region's) and never checked the manager's OWN
 * placement was a genuine, non-root home.
 *
 * The clamp is now an ADMISSION query (does this caller see this project at
 * all?) run before the spend read, rather than a LEFT JOIN inside it. Same
 * predicate, same gate, same "0 for an out-of-subtree id" behaviour — it just
 * no longer forces the spend sum to be a second, bespoke definition.
 */
import { defineEventHandler, createError } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { orgSubtreeScopePredicate } from '../../../../auth/org-subtree-scope'
import { getDb } from '../../../../db'
import { withRequestRls } from '../../../../db/request-rls'
import { requireUuidParam } from '../../../../utils/require-uuid-param'
import { monthToDateWindow } from '../../../../utils/period'
import { completeOneProjectSpend } from '../../../../usage/complete-spend'

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'manager', 'admin', 'global-finops')
  const id = requireUuidParam(event, 'id', 'project id')

  const db = getDb()
  // Region-bound the admin to the PROJECT's region before reading any spend
  // (API-1): without this, a region-scoped admin could read any project's
  // consumption cross-region by id — the breakdown/export endpoints close the
  // identical hole via requireRegionScope. Managers are NOT region-gated here
  // (requireRegionScope would deny them outright); their bound is the
  // org-subtree predicate in the admission query below.
  const projRows = await db.execute<{ region_id: string }>(sql`
    SELECT region_id::text AS region_id FROM project WHERE id = ${id}::uuid LIMIT 1
  `)
  const proj = [...projRows][0]
  if (!proj) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found' })
  }
  if (session.role !== 'manager') {
    await requireRegionScope(event, proj.region_id)
  }

  // MONTH TO DATE — ends at now, not at the month end (server/utils/period.ts).
  const window = monthToDateWindow()

  return await withRequestRls(event, async (tx) => {
    // Admission: the org-subtree clamp, unchanged. No row = out of scope, which
    // returns the same zero payload it always did (never another org's sum).
    const admitted = await tx.execute<{ ok: number }>(sql`
      SELECT 1 AS ok
        FROM project p
        JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
       WHERE p.id = ${id}::uuid
         AND ${orgSubtreeScopePredicate('cou')}
       LIMIT 1
    `)
    if ([...admitted].length === 0) {
      return { project_id: id, total_cost_usd: '0.00', total_tokens: 0, reconciled_cost_usd: '0.00' }
    }

    const spend = await completeOneProjectSpend(tx, id, window, { excludeProvisional: true })
    return {
      project_id: id,
      total_cost_usd: spend.costUsd.toFixed(2),
      total_tokens: spend.tokens,
      // The share with no model axis and no presence in `attribution_aggregate`
      // — surfaced so the editor can say where the number came from rather than
      // let a PM assume it is all emitted telemetry.
      reconciled_cost_usd: spend.reconciledUsd.toFixed(2),
    }
  })
})
