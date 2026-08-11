/*
 * GET /api/v1/admin/report-visibility — the report-visibility policy (mig 0087)
 * as the admin editor sees it: the CURRENT mode + who set it & when, plus the
 * three preset modes with their labels, one-line descriptions, and the
 * who-sees-what matrix.
 *
 * The matrix is rendered from reportGrants() LIVE — the SAME primitive the
 * enforcement path (report-scope.ts) calls — so the admin preview shows
 * enforcement truth by construction and can never drift from the gate it
 * previews. (The static WHO_SEES_WHAT literal in shared/auth/report-visibility.ts
 * stays an independent test-only cross-check pinning reportGrants; it is NOT read
 * here.)
 *
 * Read gate: admin | global-finops. A REGION admin may READ the org-wide policy
 * (so they can see what applies to them); only org-wide admins may WRITE it (see
 * .put.ts). Absent row (or absent table on a fresh upgrade) ⇒ 'standard',
 * fail-closed to today's behaviour (sg-L11).
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import {
  REPORT_VISIBILITY_MODES,
  REPORT_VISIBILITY_LABELS,
  REPORT_VISIBILITY_DESCRIPTIONS,
  REPORT_VISIBILITY_PERSONAS,
  reportGrants,
  grantsToScopes,
  type ReportVisibilityMode,
} from '../../../../shared/auth/report-visibility'

interface Row extends Record<string, unknown> {
  mode: string
  updated_by: string | null
  updated_by_name: string | null
  updated_at: string | null
}

// Any non-enum DB value (or absent row) maps to 'standard' — the fail-closed
// default, consistent with getReportVisibilityMode's contract (sg-M5).
function normaliseMode(value: string | null | undefined): ReportVisibilityMode {
  return (REPORT_VISIBILITY_MODES as readonly string[]).includes(value ?? '')
    ? (value as ReportVisibilityMode)
    : 'standard'
}

// `grantsToScopes` now lives in shared/auth/report-visibility.ts beside the
// grants it renders, so this pane and the diagnostics unhomed probe use ONE
// vocabulary rather than two that drift.

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')

  return await withRequestRls(event, async (tx) => {
    // Table-existence guard via `to_regclass` (returns NULL, never throws) so a
    // fresh upgrade with the migration not yet applied degrades to 'standard' —
    // the SAME mechanism getReportVisibilityMode's enforcement path uses, so both
    // paths degrade identically (sg-L11) rather than one sniffing an error code.
    let row: Row | undefined
    const [present] = [
      ...(await tx.execute<{ present: boolean }>(sql`
        SELECT to_regclass('report_visibility_setting') IS NOT NULL AS present`)),
    ]
    if (present?.present) {
      const rows = await tx.execute<Row>(sql`
        SELECT rvs.mode,
               rvs.updated_by::text AS updated_by,
               t.display_name       AS updated_by_name,
               rvs.updated_at::text AS updated_at
          FROM report_visibility_setting rvs
          LEFT JOIN teammate t ON t.id = rvs.updated_by
         WHERE rvs.key = 'policy'
         LIMIT 1
      `)
      row = [...rows][0]
    }

    const mode = normaliseMode(row?.mode)
    const modes = REPORT_VISIBILITY_MODES.map((m) => ({
      mode: m,
      label: REPORT_VISIBILITY_LABELS[m],
      description: REPORT_VISIBILITY_DESCRIPTIONS[m],
      matrix: REPORT_VISIBILITY_PERSONAS.map((p) => ({
        persona: p.label,
        // Render the preview from reportGrants() LIVE — the SAME primitive the
        // enforcement path calls — so the pane shows enforcement truth by
        // construction and can never silently diverge from the gate. (The
        // WHO_SEES_WHAT literal stays a pure test artefact: the unit test pins
        // reportGrants against it as an independent cross-check.)
        scopes: grantsToScopes(reportGrants(m, { role: p.role, ownsCostCentre: p.ownsCostCentre })),
      })),
    }))

    return {
      mode,
      updated_by: row?.updated_by ?? null,
      updated_by_name: row?.updated_by_name ?? null,
      updated_at: row?.updated_at ?? null,
      modes,
    }
  })
})
