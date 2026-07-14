/*
 * POST /api/v1/admin/reconciliation/github/map — map an UNRESOLVED github Copilot login to an
 * existing teammate (identity-tail layer 3). Writes the ENTERPRISE lane of teammate_identity_map
 * (source='admin-manual', verified), so the reconciler's roster reader (resolveGithubRoster)
 * picks it up and the login's Copilot spend attributes to the chosen teammate on the next run.
 *
 * Body (zod): { enterpriseId (uuid), login, teammateId (uuid), licenseOrg? }.
 *
 * MONEY PATH — invariants (surfaced as clean statuses, never raw 500s):
 *   - enterprise must exist AND be provider='github' (else 404 / 400).
 *   - teammate must exist AND be non-provisional (a provisional shadow is not a real attribution
 *     target — mirrors the money-path guard in github-identity.ts resolveTeammateId).
 *   - login charset is constrained (same floor as me/identities.post).
 *   - the write is the ENTERPRISE lane (enterprise_slug = the slug, lowercased — canonical
 *     casing, mig 0062), on the widened unique key (system, COALESCE(enterprise_slug,''),
 *     lower(identifier)). It is IDEMPOTENT (ON CONFLICT DO UPDATE): an admin re-map cleanly
 *     re-binds (authoritative, like directory-sync). It CANNOT clobber a self-service link —
 *     that row is the NULL lane (a different COALESCE('') key). A genuine constraint race
 *     (e.g. the teammate deleted mid-write) is translated to a clean 409/404, never a 500.
 *
 * RBAC: requireRole(admin, global-finops) + assertSameOrigin. INSERT + audit in ONE tx (SYS-3),
 * so a map never lands unaudited. Mirrors orgs.post.ts / me/identities.post.ts idioms.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { readValidated } from '../../../../../utils/validated-body'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { translatePgConstraintError } from '../../../../../utils/pg-constraint-error'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const Body = z.object({
  enterpriseId: z.string().regex(UUID_RE),
  teammateId: z.string().regex(UUID_RE),
  // Same charset floor as me/identities.post — this value is persisted then interpolated into
  // the reconciler's login lookups; keep an attacker-controlled value off that surface.
  login: z.string().min(1).max(200).regex(/^[\w.@+-]+$/, 'invalid login characters'),
  // The seat's license org (from the unresolved list's context), when known — persisted for
  // parity with the directory-sync writer. Optional; a lowercase org-slug charset floor.
  licenseOrg: z.string().min(1).max(200).regex(/^[\w.-]+$/).nullish(),
})

function badRequest(detail: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: 'Invalid identity map',
    data: { type: 'https://tokenscope.example.com/errors/validation', title: 'Invalid identity map', status: 400, detail },
  })
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  const login = body.login.trim().toLowerCase()
  const licenseOrg = body.licenseOrg ? body.licenseOrg.trim().toLowerCase() : null

  return await withRequestRls(event, async (tx) => {
    // Enterprise must exist AND be a github enterprise. enterprise_slug is canonical lowercase.
    const entRows = await tx.execute<{ provider: string; external_id: string }>(sql`
      SELECT provider, external_id FROM provider_enterprise WHERE id = ${body.enterpriseId}::uuid LIMIT 1
    `)
    const ent = [...entRows][0]
    if (!ent) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Enterprise not found',
        data: { type: 'https://tokenscope.example.com/errors/not-found', title: 'Enterprise not found', status: 404, detail: 'No provider_enterprise matches enterpriseId.' },
      })
    }
    if (ent.provider !== 'github') badRequest('The identity map is GitHub-only.')
    const slug = ent.external_id.toLowerCase()

    // Teammate must exist AND be non-provisional (a provisional shadow is never an attribution
    // target — the same money-path guard the directory-sync resolver uses).
    const tmRows = await tx.execute<{ provisional: boolean }>(sql`
      SELECT provisional FROM teammate WHERE id = ${body.teammateId}::uuid LIMIT 1
    `)
    const tm = [...tmRows][0]
    if (!tm) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Teammate not found',
        data: { type: 'https://tokenscope.example.com/errors/not-found', title: 'Teammate not found', status: 404, detail: 'No teammate matches teammateId.' },
      })
    }
    if (tm.provisional) badRequest('Cannot map to a provisional (shadow) teammate — pick a real teammate.')

    // Authoritative ENTERPRISE-lane upsert on the widened, case-insensitive key. Cannot clobber a
    // self-service link (NULL lane → different COALESCE('') key). Idempotent admin re-bind.
    let mapId: string
    try {
      mapId = await (async () => {
        const [row] = await tx.execute<{ id: string }>(sql`
          INSERT INTO teammate_identity_map (
            teammate_id, system, identifier, identifier_kind, github_login, enterprise_slug,
            license_org, billing_relationship, source, is_pinned, is_canonical, verified_at
          ) VALUES (
            ${body.teammateId}::uuid, 'github', ${login}, 'username', ${login}, ${slug},
            ${licenseOrg}, 'enterprise-reconciled', 'admin-manual', false, false, now()
          )
          ON CONFLICT (system, (COALESCE(enterprise_slug, '')), (lower(identifier)))
          DO UPDATE SET
            teammate_id = EXCLUDED.teammate_id,
            github_login = EXCLUDED.github_login,
            license_org = EXCLUDED.license_org,
            billing_relationship = EXCLUDED.billing_relationship,
            source = EXCLUDED.source,
            verified_at = EXCLUDED.verified_at
          RETURNING id::text AS id
        `)
        return row!.id
      })()
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        // Teammate FK vanished mid-write, or a concurrent conflicting insert on the widened key.
        '23503': { status: 404, title: 'Teammate not found', detail: 'The teammate was deleted while mapping.' },
        '23505': { title: 'Login mapped concurrently', detail: 'That login was mapped concurrently — reload and retry.' },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'copilot-login-mapped',
      actorTeammateId: caller.teammateId,
      subjectKind: 'teammate',
      subjectId: body.teammateId,
      payload: { system: 'github', enterprise_slug: slug, login, license_org: licenseOrg, source: 'admin-manual' },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id: mapId, enterpriseSlug: slug, login, teammateId: body.teammateId, source: 'admin-manual' }
  })
})
