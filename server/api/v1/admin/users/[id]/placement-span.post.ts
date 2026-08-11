/*
 * POST /api/v1/admin/users/:id/placement-span — what an admin correction WOULD
 * move, and how many Business Units it would collapse.
 *
 * Read-only. A POST because it takes a range in a body, not because it writes:
 * nothing here mutates and the handler holds no locks.
 *
 * WHY THIS EXISTS. `PATCH .../org-unit { rehome }` moves every dollar this
 * person has ever recorded onto one Business Unit. When their history already
 * spans several — because they genuinely moved team once — "all history"
 * silently rewrites a past that was correct. The data cannot distinguish that
 * from a mis-placement, so the operator is shown the span and decides; the
 * alternative is a confirmation dialog that cannot describe its own effect.
 *
 * Deliberately NOT a preview token. Migrate's `migrate_expect_token` exists
 * because that move is scoped by a shared predicate over a project's rows, so a
 * concurrent write changes what the button does. This is scoped to ONE teammate
 * whose row the PATCH locks `FOR UPDATE`; the worst drift is a few dollars of
 * newer usage moving too, which is the intended outcome either way.
 *
 * Same authorisation as the PATCH it precedes: admin/global-finops, bounded to
 * the teammate's own region. A span that leaked another region's usage totals
 * would be an information-disclosure bug wearing a dry-run's clothes.
 */
import { defineEventHandler, createError, getRouterParam } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { readValidated } from '../../../../../utils/validated-body'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { planRehomePlacement } from '../../../../../governance/rehome-placement'
import { isRealUtcDay } from '#shared/schemas/activity'

const Body = z.object({
  /*
   * Mirrors the PATCH's `rehome` exactly. A preview of a different range than
   * the one that will run is worse than no preview.
   */
  range: z.union([
    z.object({ from: z.literal('all') }),
    // A REAL day, not just the shape: `2026-02-31` matches the regex, reaches
    // Postgres's ::date cast and aborts the query — a 500 on a caller error.
    z.object({ from: z.string().refine(isRealUtcDay, 'not a real calendar day') }),
  ]),
})

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requireRole(event, 'admin', 'global-finops')

  const parsedId = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!parsedId.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid teammate id',
      data: {
        type: 'https://tokenscope.example.com/errors/invalid-input',
        title: 'Invalid teammate id',
        status: 400,
        detail: 'Expected a canonical UUID in the URL path.',
      },
    })
  }
  const teammateId = parsedId.data
  const body = await readValidated(event, Body)

  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<{ region_id: string; org_unit_id: string | null }>(sql`
      SELECT region_id::text AS region_id, org_unit_id::text AS org_unit_id
        FROM teammate WHERE id = ${teammateId}::uuid LIMIT 1`)
    const teammate = [...rows][0]
    if (!teammate) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Teammate not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Teammate not found',
          status: 404,
          detail: 'No teammate matches the supplied id (or RLS denied access).',
        },
      })
    }
    await requireRegionScope(event, teammate.region_id)

    const span = await planRehomePlacement(tx, { teammateId, range: body.range })
    return { current_org_unit_id: teammate.org_unit_id, ...span }
  })
})
