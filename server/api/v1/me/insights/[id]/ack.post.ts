/*
 * POST /api/v1/me/insights/{id}/ack — dismiss an insight card for the
 * current calendar month (PO decision: month-scoped; a persisting pattern
 * may resurface next month). Idempotent upsert; self-scoped by design and
 * by the insight_ack RLS policy (mig 0046).
 */
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { FINDING_IDS } from '../../../../../usage/insights'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const parsed = z.enum(FINDING_IDS).safeParse(getRouterParam(event, 'id'))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown insight id' })
  }
  await withRequestRls(event, (tx) =>
    tx.execute(sql`
      INSERT INTO insight_ack (teammate_id, finding_id, month)
      VALUES (${session.teammateId}::uuid, ${parsed.data},
              to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'))
      ON CONFLICT (teammate_id, finding_id, month) DO NOTHING
    `),
  )
  return { acknowledged: parsed.data }
})
