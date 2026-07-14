/*
 * GET /api/v1/admin/rate-cards — the rate-card registry for the admin
 * Rate-cards tab (PRD COST-5, safe half: CRUD only, NO recost).
 *
 * Scope mirrors the governance-settings list: a region admin sees the GLOBAL
 * cards (what their region inherits) plus their OWN region's cards;
 * global-finops / platform-admin see every card. `in_use` is the COST-7
 * pin signal — EXISTS attribution_record referencing the card — surfaced so
 * the UI can explain why cards are retired, never deleted or edited.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { isPlatformAdmin } from '../../../../../shared/auth/roles'
import { parseTstzrangeText } from '../../../../utils/allocation-validation'

interface Row extends Record<string, unknown> {
  id: string
  scope_key: string
  region_id: string | null
  region_code: string | null
  cou_id: string | null
  effective: string
  basis: string
  provenance: Record<string, unknown>
  version: number
  retired_at: string | null
  line_count: string
  in_use: boolean
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  const regionUnbounded = isPlatformAdmin(caller.role) || caller.role === 'global-finops'

  const rows = await withRequestRls(event, async (tx) => {
    // Region admins are clamped to global + own-region app-side (RLS is inert
    // at runtime — owner connection), matching the governance-settings list.
    const data = await tx.execute<Row>(sql`
      SELECT rc.id::text AS id,
             rc.scope_key,
             rc.region_id::text AS region_id,
             r.code AS region_code,
             rc.cou_id::text AS cou_id,
             rc.effective::text AS effective,
             rc.basis,
             rc.provenance,
             rc.version,
             rc.retired_at::text AS retired_at,
             (SELECT COUNT(*) FROM rate_line rl WHERE rl.rate_card_id = rc.id)::text AS line_count,
             -- COST-7: costed records pin the card (attribution_record.rate_card_id).
             EXISTS (SELECT 1 FROM attribution_record ar WHERE ar.rate_card_id = rc.id) AS in_use
        FROM rate_card rc
        LEFT JOIN region r ON r.id = rc.region_id
       WHERE (${regionUnbounded} OR rc.region_id IS NULL OR rc.region_id = ${caller.regionId}::uuid)
       ORDER BY rc.scope_key, lower(rc.effective) DESC, rc.version DESC
    `)
    return [...data]
  })

  return {
    rate_cards: rows.map((row) => {
      // Server-parsed bounds (FE-1): clients must NOT regex-parse the raw
      // tstzrange text — PG's quoted-bound format only parses under V8 leniency.
      const { from, to } = parseTstzrangeText(row.effective)
      return {
        id: row.id,
        scope_key: row.scope_key,
        region_id: row.region_id,
        region_code: row.region_code,
        cou_id: row.cou_id,
        effective: row.effective,
        effective_from: from,
        effective_to: to,
        basis: row.basis,
        provenance: row.provenance,
        version: row.version,
        retired_at: row.retired_at,
        line_count: Number(row.line_count),
        in_use: row.in_use,
      }
    }),
  }
})
