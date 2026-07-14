/*
 * GET /api/v1/instances/{instanceId}/project-resolve?code_hash=<64hex>
 * — "is this project code_hash billable for the bearer-bound teammate on THIS
 * deployment's env?" The device-side answer the plugin uses to warn when a
 * repo's `.tokenscope` names a project that isn't billable where it emits.
 *
 * Emit-credential authed (the SAME gate as /bearer + /health: requireOAuthBearer
 * 'tokenscope.emit' + ownership). Because the emit token authenticates to the
 * device's OWN env server, `billable:true` ⟺ billable-on-the-emit-env — there is
 * no read/emit env divergence to produce a false match, and no MCP/read auth or
 * model action is needed.
 *
 * No existence oracle: an UNKNOWN code_hash and a real-but-not-a-member code_hash
 * both return `billable:false` (resolveRepoProject is membership-gated). On the
 * negative path we also return `your_projects` (the caller's OWN memberships only,
 * via getMyProjects — leaks nothing about anyone else) so the plugin's warning is
 * self-service actionable. Only the hash is accepted/returned — never a repo path.
 */
import { createError, defineEventHandler, getRouterParam, getQuery } from 'h3'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb, schema } from '../../../../db'
import { requireOAuthBearer } from '../../../../auth/oauth-bearer'
import { resolveRepoProject, getMyProjects } from '../../../../utils/me-queries'

const SidSchema = z.string().uuid()
const CodeHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'code_hash must be 64 lowercase hex chars')

export default defineEventHandler(async (event) => {
  const parsedSid = SidSchema.safeParse(getRouterParam(event, 'instanceId'))
  if (!parsedSid.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid instance id' })
  }
  const sid = parsedSid.data

  const parsedHash = CodeHashSchema.safeParse(getQuery(event).code_hash)
  if (!parsedHash.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid code_hash' })
  }
  const codeHash = parsedHash.data

  const db = getDb()

  // Same gate as /bearer + /health — the emit credential, scope + revocation checked.
  const teammate = await requireOAuthBearer(event, 'tokenscope.emit', db as never)

  // Ownership: the bound teammate MUST own this instance (mirrors /health).
  const [row] = await db
    .select({
      instanceId: schema.instanceAttestation.instanceId,
      teammateId: schema.instanceAttestation.teammateId,
    })
    .from(schema.instanceAttestation)
    .where(eq(schema.instanceAttestation.instanceId, sid))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Instance not found' })
  }
  if (!row.teammateId || row.teammateId !== teammate.teammateId) {
    throw createError({
      statusCode: 403,
      statusMessage: 'This credential does not own the requested instance',
    })
  }

  // Membership-gated resolution. Match → billable; no match (unknown OR not a
  // member) → not billable, with the caller's own budgets to re-tag against.
  const project = await resolveRepoProject(db as never, teammate.teammateId, { codeHash })
  if (project) {
    return {
      instance_id: sid,
      code_hash: codeHash,
      billable: true,
      project: { id: project.id, code: project.code, display_name: project.display_name, type: project.type },
    }
  }

  const yourProjects = await getMyProjects(db as never, teammate.teammateId)
  return {
    instance_id: sid,
    code_hash: codeHash,
    billable: false,
    your_projects: yourProjects.map((p) => ({ id: p.id, code: p.code, display_name: p.display_name, type: p.type })),
  }
})
