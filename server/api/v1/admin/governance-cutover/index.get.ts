/*
 * GET /api/v1/admin/governance-cutover — current cutover state (status,
 * preflight snapshot, timestamps). global-finops ONLY (mirrors the
 * ab-decomposition diagnostics precedent — this is estate-wide, irreversible-
 * adjacent state, not a region-scoped admin concern).
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { getCutoverState } from '../../../../governance/cutover'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'global-finops')
  return withRequestRls(event, async (tx) => {
    const state = await getCutoverState(tx)
    return {
      status: state.status,
      preflightSnapshot: state.preflightSnapshot,
      preflightVerifiedAt: state.preflightVerifiedAt,
      preflightVerifiedBy: state.preflightVerifiedBy,
      activatedAt: state.activatedAt,
      activatedBy: state.activatedBy,
      rolledBackAt: state.rolledBackAt,
      rolledBackBy: state.rolledBackBy,
    }
  })
})
