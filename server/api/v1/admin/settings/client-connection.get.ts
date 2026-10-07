/*
 * GET /api/v1/admin/settings/client-connection — the "Client connection" policy
 * (mig 0151) for the admin card. Platform-admin only, like the PUT.
 *
 * `configured: false` means no row is stored and the values are the defaults the
 * dialog falls back to.
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { getClientConnectionRow, toWire } from '../../../../db/client-connection'
import { DEFAULT_CLIENT_CONNECTION } from '../../../../../shared/connect'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'platform-admin')
  return await withRequestRls(event, async (tx) => {
    const row = await getClientConnectionRow(tx)
    if (!row) {
      return { configured: false, ...toWire(DEFAULT_CLIENT_CONNECTION), updated_by: null, updated_at: null }
    }
    return { configured: true, ...toWire(row), updated_by: row.updatedBy, updated_at: row.updatedAt }
  })
})
