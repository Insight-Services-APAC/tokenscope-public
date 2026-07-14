/*
 * POST /api/v1/admin/reconciliation/github/discover-orgs — onboarding helper that,
 * given a GitHub enterprise, uses its billing PAT to read the Copilot seat roster and
 * AUTO-CREATES the provider_org rows for every license-org it finds. The admin should
 * NOT hand-type (and guess) org slugs when the enterprise PAT already lists them — this
 * is the GitHub counterpart of the Anthropic `discover` probe.
 *
 * Body (zod): { enterpriseId }.
 *
 * Discovery source: the seat roster's license-orgs (the orgs that actually hold Copilot
 * seats = the orgs with cost). Each distinct org is UPSERTED as a github provider_org
 * linked to this enterprise (reconciliation_mode='reconciled', billing='tracked'),
 * idempotently — an existing org is left as-is (its region/notes are preserved) but
 * linked to the enterprise if it wasn't. The admin then just sets each org's region.
 *
 * Response 200: { discovered, created, linked, alreadyLinked, orgs: [{login, status}] }.
 * A PAT/credential failure returns 422 with a SAFE { reason } (no key, no raw provider
 * text — the PAT is never echoed or logged).
 *
 * RBAC: requireRole(admin, global-finops) + assertSameOrigin. Audited (per created/linked org).
 */
import { defineEventHandler, createError, readValidatedBody, getRequestIP, getHeader, setResponseStatus } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { resolveEnterpriseCredential } from '../../../../../reconciliation/credentials'
import { GithubCopilotClient } from '../../../../../reconciliation/adapters/github-client'
import { seatLicenseOrg } from '../../../../../reconciliation/adapters/github'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const Body = z.object({ enterpriseId: z.string().regex(UUID_RE) })

/* Classify a thrown GitHub-client error into the SAFE discover vocabulary (mirrors the
 * anthropic discover reasons). The client throws a 502 createError carrying the upstream
 * status in detail like "seats returned HTTP 401"; map that without echoing the key. */
function classifyGithubError(err: unknown): string {
  const detail = (err as { data?: { detail?: string } } | null)?.data?.detail ?? ''
  if (/HTTP 401/.test(detail)) return '401-unauthorized'
  if (/HTTP 403/.test(detail)) return '403-forbidden-scope'
  if (/HTTP 404/.test(detail)) return '404-wrong-endpoint'
  if (/HTTP 429/.test(detail)) return '429-rate-limited'
  return 'connect-failed'
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const body = await readValidatedBody(event, (d) => Body.parse(d))
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // 1. Resolve the enterprise — must exist + be github.
    const entRows = await tx.execute<{ external_id: string; provider: string }>(sql`
      SELECT external_id, provider FROM provider_enterprise WHERE id = ${body.enterpriseId}::uuid LIMIT 1
    `)
    const ent = [...entRows][0]
    if (!ent) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Enterprise not found',
        data: { type: 'https://tokenscope.example.com/errors/not-found', title: 'Enterprise not found', status: 404, detail: 'No provider_enterprise matches enterpriseId.' },
      })
    }
    if (ent.provider !== 'github') {
      throw createError({
        statusCode: 400,
        statusMessage: 'Not a GitHub enterprise',
        data: { type: 'https://tokenscope.example.com/errors/validation', title: 'Not a GitHub enterprise', status: 400, detail: 'Org discovery is GitHub-only; Anthropic uses the per-org Discover probe.' },
      })
    }

    // 2. The enterprise PAT (presence only — value used to build the client, never returned).
    const credential = await resolveEnterpriseCredential(tx, { provider: 'github', externalId: ent.external_id })
    if (!credential) {
      setResponseStatus(event, 422)
      return { reason: 'no-key' }
    }

    // 3. Read the seat roster → distinct license-orgs (lowercased, canonical per mig 0064).
    let orgs: string[]
    try {
      const client = GithubCopilotClient.withPat(ent.external_id, credential.value)
      const seats = await client.listSeats()
      const set = new Set<string>()
      for (const seat of seats) {
        const org = seatLicenseOrg(seat)
        if (org) set.add(org.trim().toLowerCase())
      }
      orgs = [...set].filter((o) => o.length > 0).sort()
    } catch (err) {
      setResponseStatus(event, 422)
      return { reason: classifyGithubError(err) }
    }

    // 4. Upsert each org as a github provider_org linked to this enterprise. Idempotent:
    //    a brand-new org is created; an existing one is linked to the enterprise if it
    //    wasn't (its region/notes are NEVER overwritten).
    const out: Array<{ login: string; status: 'created' | 'linked' | 'already' }> = []
    let created = 0
    let linked = 0
    let alreadyLinked = 0
    for (const login of orgs) {
      const existing = await tx.execute<{ id: string; provider_enterprise_id: string | null }>(sql`
        SELECT id::text AS id, provider_enterprise_id::text AS provider_enterprise_id
        FROM provider_org WHERE provider = 'github' AND lower(external_org_id) = lower(${login}) LIMIT 1
      `)
      const row = [...existing][0]
      if (!row) {
        const ins = await tx.execute<{ id: string }>(sql`
          INSERT INTO provider_org (provider, external_org_id, display_name, reconciliation_mode, billing, provider_enterprise_id)
          VALUES ('github', ${login}, ${login}, 'reconciled', 'tracked', ${body.enterpriseId}::uuid)
          RETURNING id::text AS id
        `)
        created += 1
        out.push({ login, status: 'created' })
        await recordAuditEvent(tx, {
          eventType: 'provider-org-discovered',
          actorTeammateId: caller.teammateId,
          subjectKind: 'provider-org',
          subjectId: [...ins][0]!.id,
          payload: { provider: 'github', external_org_id: login, provider_enterprise_id: body.enterpriseId, via: 'github-discover-orgs' },
          ipAddress: ip,
          userAgent: ua,
        })
      } else if (row.provider_enterprise_id !== body.enterpriseId) {
        // Link an existing org to this enterprise (it had none, or a stale one). Region/notes untouched.
        await tx.execute(sql`
          UPDATE provider_org SET provider_enterprise_id = ${body.enterpriseId}::uuid WHERE id = ${row.id}::uuid
        `)
        linked += 1
        out.push({ login, status: 'linked' })
        await recordAuditEvent(tx, {
          eventType: 'provider-org-discovered',
          actorTeammateId: caller.teammateId,
          subjectKind: 'provider-org',
          subjectId: row.id,
          payload: { provider: 'github', external_org_id: login, provider_enterprise_id: body.enterpriseId, via: 'github-discover-orgs', linked: true },
          ipAddress: ip,
          userAgent: ua,
        })
      } else {
        alreadyLinked += 1
        out.push({ login, status: 'already' })
      }
    }

    return { discovered: orgs.length, created, linked, alreadyLinked, orgs: out }
  })
})
