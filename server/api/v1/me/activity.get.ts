/*
 * GET /api/v1/me/activity — ONE list of what the caller did: OTel-observed
 * sessions AND provider-recorded days, each labelled with its kind, filterable,
 * keyset-paged (D17/D18/D20).
 *
 * It REPLACES `/me/sessions/recent` and `/me/sessions/recent/export`, which are
 * retired in the same change. Those read `attribution_record` alone, so a
 * provider-recorded day could never appear on them, and the worklist —
 * `project_id IS NULL` by definition — dropped such a day the instant it was
 * tagged. Between them, nothing owned "a provider-recorded day after it has
 * been decided". The needs-tagging worklist (`/me/sessions/untagged`) STAYS: it
 * is the task list, this is the record.
 *
 * NO TOTAL IS RETURNED, deliberately (D19). See shared/schemas/activity.ts.
 */
import { createError, defineEventHandler, getValidatedQuery } from 'h3'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { fetchActivityPage } from '../../../usage/activity-list'
import { ActivityListQuery, type ActivityListResponse } from '#shared/schemas/activity'

export default defineEventHandler(async (event): Promise<ActivityListResponse> => {
  const session = await requireAuth(event)
  const { cursor, limit, ...filters } = await getValidatedQuery(event, (d) =>
    ActivityListQuery.parse(d),
  )

  try {
    const page = await withRequestRls(event, (tx) =>
      fetchActivityPage(tx, session.teammateId, filters, {
        limit,
        cursor,
        withBreakdowns: true,
      }),
    )
    return {
      rows: page.rows,
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
    }
  } catch (e: unknown) {
    // A cursor is opaque to the caller, so a malformed one is a bad request,
    // never a 500 — and never a silently-reset first page, which would make a
    // paging bug look like a duplicate row.
    if (e instanceof Error && e.message === 'activity-list: invalid cursor') {
      throw createError({ statusCode: 400, statusMessage: 'Invalid cursor' })
    }
    throw e
  }
})
