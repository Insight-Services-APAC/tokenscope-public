/*
 * POST /api/v1/me/worklist/bulk — apply ONE decision to a SET of needs-tagging
 * items (conversations and/or provider-recorded §A days):
 *
 *   { action: 'tag',     sessions: [...], unaccounted: [...], project_id?, activity? }
 *   { action: 'dismiss', sessions: [...], unaccounted: [...] }
 *   { action: 'restore', sessions: [...], unaccounted: [...] }
 *
 * Self-scoped like every /me route (requireAuth): the caller can only act on
 * their own items, enforced by an explicit ownership pre-flight inside
 * applyWorklistBulk rather than by RLS. The batch is atomic — one transaction,
 * all gates first, nothing changed if any item fails.
 *
 * Dismissal moves an item OUT of the worklist and changes no money: the spend
 * stays unallocated and still charges to the caller's cost centre. See
 * docs/design/needs-tagging-worklist.md.
 */
import { defineEventHandler } from 'h3'
import { requireAuth } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { readValidated } from '../../../../utils/validated-body'
import { applyWorklistBulk } from '../../../../utils/worklist-bulk'
import { WorklistBulkBody } from '#shared/schemas/worklist'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const body = await readValidated(event, WorklistBulkBody)

  // withRequestRls IS the transaction — the batch stays atomic and now carries
  // the caller's RLS identity for every statement in it.
  return await withRequestRls(event, (tx) => applyWorklistBulk(tx, session.teammateId, body))
})
