/*
 * GET /api/v1/me/identities — the caller's linked identities (the Claude /
 * GitHub / client emails they use), so spend across identities attributes to
 * them. The primary (teammate.email) plus any teammate_identity_map rows.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const { me, rows } = await withRequestRls(event, async (tx) => {
    const [me] = await tx.execute<{ email: string }>(
      sql`SELECT email FROM teammate WHERE id = ${session.teammateId}::uuid`,
    )
    const rows = await tx.execute<{
      id: string
      system: string
      identifier: string
      identifier_kind: string
      verified: boolean
      source: string
    }>(sql`
      SELECT id::text AS id, system, identifier, identifier_kind,
             (verified_at IS NOT NULL) AS verified, source
      FROM teammate_identity_map
      WHERE teammate_id = ${session.teammateId}::uuid
      ORDER BY system, identifier
    `)
    return { me, rows }
  })
  return {
    primary: me?.email ?? session.email,
    identities: [...rows].map((r) => ({
      id: r.id,
      system: r.system,
      identifier: r.identifier,
      kind: r.identifier_kind,
      verified: r.verified,
      source: r.source,
    })),
  }
})
