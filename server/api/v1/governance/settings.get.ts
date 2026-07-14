/*
 * GET /api/v1/governance/settings — the RESOLVED governance dials for the
 * caller's region (mig 0049): region override wins over the platform row.
 * Any authenticated user — dials are not sensitive, and clients (dashboards,
 * drawers) need the effective bar to label what a flag means.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { GOVERNANCE_SETTING_KEYS } from '../../../utils/governance-settings'

interface SettingRow extends Record<string, unknown> {
  key: string
  scope_type: string
  value_numeric: string
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)

  return await withRequestRls(event, async (tx) => {
    // One pull: the platform baselines + the caller-region overrides. The
    // region row wins per key; overridden keys are surfaced so the UI can
    // mark "regional" vs "platform default".
    // NB: drizzle renders an array param as a parenthesised list — IN, not ANY.
    const rows = await tx.execute<SettingRow>(sql`
      SELECT key, scope_type, value_numeric::text AS value_numeric
        FROM governance_setting
       WHERE key IN ${GOVERNANCE_SETTING_KEYS}
         AND (scope_type = 'platform'
              OR (scope_type = 'region' AND scope_id = ${session.regionId}::uuid))
    `)
    const settings: Record<string, number> = {}
    const overrides: string[] = []
    for (const r of rows) {
      if (r.scope_type === 'region') {
        settings[r.key] = Number(r.value_numeric)
        overrides.push(r.key)
      } else if (!(r.key in settings)) {
        settings[r.key] = Number(r.value_numeric)
      }
    }
    return {
      settings,
      scope: { region_id: session.regionId, overrides: overrides.sort() },
    }
  })
})
