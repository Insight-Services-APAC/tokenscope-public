/*
 * GET /api/v1/me/unaccounted/{id} — full detail for ONE provider-recorded day.
 * Design: docs/design/reporting-consolidation/05-api-sourced-usage-carries-its-
 * dimensions.md work item 2. Response shape:
 * shared/schemas/provider-day.ts::ProviderDayDetail.
 *
 * The drill-down counterpart of GET /me/sessions/{sid}, for the unit that has no
 * session: a (teammate, day, tool) record the provider's API reported because
 * OTel captured nothing. It shows the same things a session's detail shows —
 * model mix, where the tokens went, cost by model, requests — read from the
 * provider's OWN rows in `provider_usage_fact` rather than derived from
 * anything. All of it in one statement; see server/usage/provider-day-detail.ts.
 *
 * Ownership is the query's WHERE clause, exactly as the session endpoint does
 * it: a record that exists but belongs to someone else is indistinguishable from
 * one that does not exist, so both 404 and neither can be probed for.
 */
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { fetchProviderDayDetail } from '../../../../../usage/provider-day-detail'
import type { ProviderDayDetail } from '#shared/schemas/provider-day'

export default defineEventHandler(async (event): Promise<ProviderDayDetail> => {
  const session = await requireAuth(event)
  const idParsed = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!idParsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid record id' })
  }

  const detail = await withRequestRls(event, (tx) =>
    fetchProviderDayDetail(tx, session.teammateId, idParsed.data),
  )

  if (!detail) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Record not found',
      data: {
        type: 'https://tokenscope.example.com/errors/not-found',
        title: 'Record not found',
        status: 404,
        detail: 'No provider-recorded day with that id under your account.',
      },
    })
  }
  return detail
})
