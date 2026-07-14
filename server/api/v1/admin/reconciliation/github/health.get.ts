/*
 * GET /api/v1/admin/reconciliation/github/health?enterpriseId=<uuid> — a LIVE,
 * classified, KEY-SAFE health/verify probe for ONE GitHub Copilot enterprise. The
 * GitHub twin of the Anthropic health route.
 *
 * GOAL: an admin clicks "Verify" and sees exactly WHERE this enterprise's reconciliation
 * pipeline breaks — egress vs auth vs metrics-empty vs no-teammate-match — because the
 * worker logs are NSP-locked (inaccessible). The verdict/color + per-stage lines make the
 * break point legible without any log access.
 *
 * SAFETY: never throws for a probe failure (computeGithubEnterpriseHealth catches +
 * classifies every stage), never returns/logs the App key, PEM, installation token, PAT,
 * or a raw provider error body. RBAC: requireRole(admin, global-finops) — same guard as the
 * enterprises reader. No assertSameOrigin: this is a GET (read-only probe), not a mutation,
 * matching the Anthropic health route's convention. provider_enterprise has no RLS → getDb().
 */
import { defineEventHandler, getValidatedQuery, createError } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { getDb } from '../../../../../db'
import { computeGithubEnterpriseHealth, type GithubEnterpriseRow } from '../../../../../reconciliation/github-health'

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
  // safeParse → a proper 400 on a missing/invalid enterpriseId (never an unhandled 500;
  // never echo the input back).
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
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Enterprise not found' })
  }
  if (row.provider !== 'github') {
    // Wrong-provider is a VALIDATION error (the row exists — the caller asked the wrong
    // probe): 400, matching discover-orgs' convention. Anthropic has its own health route.
    throw createError({
      statusCode: 400,
      statusMessage: 'Not a GitHub enterprise',
      data: {
        type: 'https://tokenscope.example.com/errors/validation',
        title: 'Not a GitHub enterprise',
        status: 400,
        detail: 'The verify probe is GitHub-only; Anthropic orgs use the anthropic health route.',
      },
    })
  }

  const ent: GithubEnterpriseRow = {
    enterpriseId: row.id,
    externalId: row.external_id,
    githubAppId: row.github_app_id,
  }
  return await computeGithubEnterpriseHealth(db, ent)
})
