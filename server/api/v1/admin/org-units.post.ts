/*
 * POST /api/v1/admin/org-units — create a cost centre / org unit
 * (admin org-units tab, design-notes §Screen 5).
 *
 * Why this exists: until now the org tree was seed-only (GET org-units
 * reads it; nothing writes it). Admins need to stand up new cost centres
 * and intermediate units without a re-seed. A "cost centre" is just an
 * org_unit with is_cost_owning_unit = true — the same row shape, so this
 * one endpoint mints both.
 *
 * LTREE care: the path is built from a derived label (the code, lowercased
 * with any non [a-z0-9_] char folded to '_') because LTREE labels accept
 * only [A-Za-z0-9_] — a code like 'AFL-DRP' would be an illegal label, so
 * it becomes 'afl_drp'. Two distinct codes can fold to the same label, so
 * we guard the derived path for uniqueness in the region as well as the
 * (region_id, code) UNIQUE constraint. The path is written via raw sql
 * with a ::ltree cast (Drizzle's customType can't parameterise the cast).
 *
 * Scope: admin / global-finops only; a region admin is bound to their own
 * region (requireRegionScope), and a child unit's parent must live in the
 * same region.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import { recordAuditEvent } from '../../../db/audit'
import { assertHoldingNodeNotCostOwning } from '../../../db/org-units'

const Body = z.object({
  region_id: z.string().uuid(),
  parent_id: z.string().uuid().nullable().optional(),
  code: z.string().min(2).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'invalid org unit code'),
  display_name: z.string().min(1).max(200),
  unit_type: z.string().min(1).max(40),
  is_cost_owning_unit: z.boolean().default(false),
})

/*
 * Derive a legal LTREE label from a code: lowercase, then fold any char
 * outside [a-z0-9_] to '_'. 'AFL-DRP' → 'afl_drp', 'as.svc' → 'as_svc'.
 */
function deriveLabel(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9_]/g, '_')
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)

  // S3 part (f): 'default' is RESERVED for a region's root org unit — the one
  // regions.post.ts plants automatically, parentless, in the same transaction as
  // the region insert. This endpoint never creates that row (it always creates
  // through the normal parent/path derivation below), so 'default' is reserved
  // unconditionally here. Without this, a legitimate non-root unit coded
  // 'default' — the (region_id, code) unique allows it in any OTHER region —
  // would blind placedBelowRegionRootPredicate()'s naming arm for a properly-
  // placed teammate on that unit (the exact false positive org-subtree-scope.ts
  // documents `code <> 'default'` alone carries).
  if (body.code === 'default') {
    throw createError({
      statusCode: 409,
      statusMessage: `Org unit code 'default' is reserved`,
      data: {
        type: 'https://tokenscope.example.com/errors/conflict',
        title: 'Conflict',
        status: 409,
        detail: `The code 'default' is reserved for a region's root org unit (created automatically when the region is created) and cannot be assigned to another unit.`,
      },
    })
  }

  await requireRegionScope(event, body.region_id)

  // Guard rail (same rule as the PATCH door): a holding node may never be
  // cost-owning — see server/db/org-units.ts for why that is not cosmetic.
  assertHoldingNodeNotCostOwning({
    unitType: body.unit_type,
    isCostOwningUnit: body.is_cost_owning_unit,
  })

  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  const label = deriveLabel(body.code)

  return await withRequestRls(event, async (tx) => {
    // Build the path. A child hangs off its parent (which must exist, be
    // active, and share the region); a root unit is just its own label.
    let path: string
    if (body.parent_id) {
      const parentRows = await tx.execute<{ path: string; region_id: string; retired_at: string | null }>(sql`
        SELECT path::text AS path, region_id::text AS region_id, retired_at
        FROM org_unit WHERE id = ${body.parent_id}::uuid LIMIT 1
      `)
      const parent = [...parentRows][0]
      if (!parent) {
        throw createError({
          statusCode: 422,
          statusMessage: 'parent_id does not exist',
          data: {
            type: 'https://tokenscope.example.com/errors/unprocessable',
            title: 'Unprocessable',
            status: 422,
            detail: 'parent_id does not reference an existing org unit.',
          },
        })
      }
      if (parent.retired_at) {
        throw createError({
          statusCode: 422,
          statusMessage: 'parent org unit is retired',
          data: {
            type: 'https://tokenscope.example.com/errors/unprocessable',
            title: 'Unprocessable',
            status: 422,
            detail: 'Cannot create a child under a retired org unit.',
          },
        })
      }
      if (parent.region_id !== body.region_id) {
        throw createError({
          statusCode: 422,
          statusMessage: 'parent org unit is in a different region',
          data: {
            type: 'https://tokenscope.example.com/errors/unprocessable',
            title: 'Unprocessable',
            status: 422,
            detail: 'parent_id must belong to the same region as region_id.',
          },
        })
      }
      path = `${parent.path}.${label}`
    } else {
      path = label
    }

    // Unique (region_id, code) pre-check → clean 409 instead of a raw
    // constraint violation.
    const dupeCode = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM org_unit
      WHERE region_id = ${body.region_id}::uuid AND code = ${body.code} LIMIT 1
    `)
    if ([...dupeCode][0]) {
      throw createError({
        statusCode: 409,
        statusMessage: `Org unit code '${body.code}' already exists in this region`,
        data: {
          type: 'https://tokenscope.example.com/errors/conflict',
          title: 'Conflict',
          status: 409,
          detail: `An org unit with code '${body.code}' already exists in this region.`,
        },
      })
    }

    // Distinct codes can fold to the same label (e.g. 'a-b' and 'a.b' both
    // → 'a_b'), which would collide on path. Guard the derived path too.
    const dupePath = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM org_unit
      WHERE region_id = ${body.region_id}::uuid AND path = ${path}::ltree LIMIT 1
    `)
    if ([...dupePath][0]) {
      throw createError({
        statusCode: 409,
        statusMessage: `Org unit path '${path}' already exists in this region`,
        data: {
          type: 'https://tokenscope.example.com/errors/conflict',
          title: 'Conflict',
          status: 409,
          detail: `The code '${body.code}' derives LTREE path '${path}', which already exists in this region. Choose a code that yields a distinct label.`,
        },
      })
    }

    const insertedRows = await tx.execute<{ id: string }>(sql`
      INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit, source)
      VALUES (
        ${body.region_id}::uuid,
        ${body.parent_id ?? null}::uuid,
        ${path}::ltree,
        ${body.code},
        ${body.display_name},
        ${body.unit_type},
        ${body.is_cost_owning_unit},
        'manual'
      )
      RETURNING id::text AS id
    `)
    const created = [...insertedRows][0]
    if (!created) throw createError({ statusCode: 500, statusMessage: 'org unit insert returned no row' })

    await recordAuditEvent(tx, {
      eventType: 'org-unit-created',
      actorTeammateId: caller.teammateId,
      actorSystem: 'admin-ui',
      subjectKind: 'org-unit',
      subjectId: created.id,
      payload: {
        code: body.code,
        path,
        region_id: body.region_id,
        parent_id: body.parent_id ?? null,
        display_name: body.display_name,
        unit_type: body.unit_type,
        is_cost_owning_unit: body.is_cost_owning_unit,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id: created.id, code: body.code, path, is_cost_owning_unit: body.is_cost_owning_unit }
  })
})
