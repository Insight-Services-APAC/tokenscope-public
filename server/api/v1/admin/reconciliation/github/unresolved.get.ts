/*
 * GET /api/v1/admin/reconciliation/github/unresolved?enterpriseId=<uuid> — the UNRESOLVED
 * github Copilot logins for ONE enterprise: those the live provider roster reports with
 * Copilot spend/seats but which the identity map does NOT bind to a teammate (either lane).
 * The identity-tail layer-3 surface: an admin maps each to an existing teammate via the sibling
 * POST /map, which writes the ENTERPRISE lane so the reconciler then attributes their spend.
 *
 * WHY LIVE (not a DB list): an unmapped login is SKIPPED before reconciliation_record is written
 * (github.ts `if (!teammateId) continue`), so it is not persisted anywhere — it lives only in
 * the live provider roster. See server/reconciliation/github-unresolved.ts.
 *
 * SAFETY: listUnresolvedCopilotLogins never returns/logs a PAT, App key, PEM, installation
 * token, or a raw provider body — only logins + numeric context. A credential/roster/upstream
 * failure surfaces as a clean, FIXED-reason status (never a partial list read as "none left").
 * RBAC: requireRole(admin, global-finops) — same guard as the github health route. GET (read-
 * only probe) → no assertSameOrigin, matching health.get.ts. provider_enterprise has no RLS →
 * getDb().
 */
import { defineEventHandler, getValidatedQuery, createError } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { getDb } from '../../../../../db'
import type { GithubEnterpriseRow } from '../../../../../reconciliation/github-health'
import { listUnresolvedCopilotLogins, UnresolvedProbeError } from '../../../../../reconciliation/github-unresolved'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const Query = z.object({ enterpriseId: z.string().regex(UUID_RE) })

interface Row extends Record<string, unknown> {
  id: string
  provider: string
  external_id: string
  github_app_id: string | null
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const query = await getValidatedQuery(event, (data) => {
    const parsed = Query.safeParse(data)
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'invalid query parameter' })
    }
    return parsed.data
  })
  const db = getDb()

  const rows = await db.execute<Row>(sql`
    SELECT id::text AS id, provider, external_id, github_app_id
    FROM provider_enterprise
    WHERE id = ${query.enterpriseId}::uuid
    LIMIT 1
  `)
  const row = [...rows][0]
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Enterprise not found' })
  if (row.provider !== 'github') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Not a GitHub enterprise',
      data: {
        type: 'https://tokenscope.example.com/errors/validation',
        title: 'Not a GitHub enterprise',
        status: 400,
        detail: 'Unresolved Copilot users are GitHub-only.',
      },
    })
  }

  const ent: GithubEnterpriseRow = { enterpriseId: row.id, externalId: row.external_id, githubAppId: row.github_app_id }
  try {
    return await listUnresolvedCopilotLogins(db, ent)
  } catch (err) {
    if (err instanceof UnresolvedProbeError) {
      // A FIXED, key-safe reason bucket → a clean 502 (upstream/probe failure). Never echo a
      // provider body; the reason enum is all the UI needs to show an honest error.
      throw createError({
        statusCode: 502,
        statusMessage: 'Could not list unresolved Copilot users',
        data: {
          type: 'https://tokenscope.example.com/errors/github-unresolved',
          title: 'Could not list unresolved Copilot users',
          status: 502,
          detail: err.reason,
        },
      })
    }
    throw err
  }
})
