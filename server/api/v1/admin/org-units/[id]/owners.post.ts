/*
 * POST /api/v1/admin/org-units/{id}/owners — assign a cost-centre owner
 * (J4, mig 0048). admin (region-scoped) / global-finops.
 *
 * The org unit must be a cost-owning unit — ownership is the P&L relationship,
 * and the owner is typically 2-3 levels removed from the unit in the org chart,
 * so ANY active teammate in the region (or outside it, for global roles) can be
 * assigned; their org role does not change.
 *
 * Two ways to identify the owner — consistent with the region-leaders picker:
 *   - { teammate_id } — an EXISTING teammate (the legacy path).
 *   - { oid }         — an Entra DIRECTORY pick (GET /admin/directory/search). The
 *                       owner may not be a teammate yet (owners are execs/leads who
 *                       often haven't signed in), so we FIND-OR-PROVISION the
 *                       teammate from the directory identity (placed in THIS
 *                       cost-centre's region default unit, role 'developer' — the
 *                       P&L grant is independent of org role), then assign.
 * Re-assigning after a revoke is allowed; duplicate ACTIVE ownership 409s on the
 * partial unique index.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { advisoryXactLock } from '../../../../../db/advisory-lock'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { translatePgConstraintError } from '../../../../../utils/pg-constraint-error'
import { ensureRealIdentity } from '../../../../../auth/ensure-real-identity'
import { assertDirectoryIdentityPickable, provisionDirectoryTeammate } from '../../../../../auth/provision-directory-teammate'
import { loadDirectoryExclusionPatterns } from '../../../../../utils/directory-exclusions'
import { getDb } from '../../../../../db'
import { getDirectoryUserByOid } from '../../../../../azure/directory'
import { couOwner } from '../../../../../../drizzle/schema'

// Exactly one of teammate_id / oid — the picker sends oid (directory), legacy
// callers may still send teammate_id.
const Body = z
  .object({
    teammate_id: z.string().uuid().optional(),
    oid: z.string().trim().min(1).max(200).optional(),
  })
  .refine((b) => (b.teammate_id ? 1 : 0) + (b.oid ? 1 : 0) === 1, {
    message: 'Provide exactly one of teammate_id or oid',
  })

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'org unit id')
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  // Directory pick: re-resolve identity SERVER-SIDE (never trust a client email /
  // display name) BEFORE the tx — getDirectoryUserByOid is a Graph call.
  const dir = body.oid ? await getDirectoryUserByOid(body.oid) : null
  if (body.oid && !dir) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Directory user not found',
      data: {
        type: 'https://tokenscope.example.com/errors/directory-user',
        title: 'Directory user not found',
        status: 404,
        detail: 'No Entra directory user matches that object id.',
      },
    })
  }
  // Excluded (privileged/service) identity picks are refused BEFORE the tx
  // (issue #121). Patterns are admin-config; a fresh install excludes nobody.
  if (dir) assertDirectoryIdentityPickable(dir, await loadDirectoryExclusionPatterns(getDb()))

  return await withRequestRls(event, async (tx) => {
    const ouRows = await tx.execute<{
      region_id: string
      is_cost_owning_unit: boolean
      display_name: string
    }>(sql`
      SELECT region_id::text AS region_id, is_cost_owning_unit, display_name
      FROM org_unit
      WHERE id = ${id}::uuid AND retired_at IS NULL
      LIMIT 1
    `)
    const ou = [...ouRows][0]
    if (!ou) {
      throw createError({ statusCode: 404, statusMessage: 'Org unit not found' })
    }
    await requireRegionScope(event, ou.region_id)
    if (!ou.is_cost_owning_unit) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Not a cost-owning unit',
        data: {
          type: 'https://tokenscope.example.com/errors/not-cost-owning',
          title: 'Not a cost-owning unit',
          status: 422,
          detail: 'Owners can only be assigned to cost-owning units. Mark the unit cost-owning first.',
        },
      })
    }

    // Resolve the owner teammate. teammate_id → adopt/merge the real identity.
    // oid → find-or-provision from the directory pick.
    let ownerTeammateId: string
    let ownerRegionId: string
    let ownerEmail: string
    let ownerDisplayName: string | null
    let adopted: boolean
    let provisioned = false

    if (dir) {
      // Find-or-provision the teammate from the directory pick — placed in the
      // cost-centre's region default unit, role 'developer' (the P&L grant is
      // independent of org role). Shared with the project-member assignment path.
      // May resolve to an EXISTING teammate (other live identity of the same
      // mailbox, or an adopted bill: placeholder — issue #121), so the result
      // is not necessarily homed in ou.region_id.
      const tm = await provisionDirectoryTeammate(tx, dir, caller.teammateId, {
        regionId: ou.region_id,
        fallbackOrgUnitId: id,
        via: 'cou-owner-assign',
      })
      ownerTeammateId = tm.teammateId
      ownerRegionId = tm.regionId
      ownerEmail = tm.email
      ownerDisplayName = tm.displayName
      provisioned = tm.provisioned
      adopted = tm.adopted
    } else {
      // The owner OID is the manager-chain match key, so a bill:/provisional: placeholder would be
      // silently invisible to the placement walk. Resolve a REAL Entra identity (adopt the
      // placeholder from the directory, or merge onto an existing real teammate).
      const owner = await ensureRealIdentity(tx, body.teammate_id!, caller.teammateId, 'cou-owner-assign')
      ownerTeammateId = owner.teammateId
      ownerRegionId = owner.regionId
      ownerEmail = owner.email
      ownerDisplayName = owner.displayName
      adopted = owner.adopted
    }

    // R1 F5: a REGION admin must not grant cross-region P&L visibility — owner and
    // unit must share a region unless the caller is a global role. (A FRESH oid
    // provision lands in ou.region_id, but the oid path can also resolve to an
    // EXISTING cross-region teammate — bill: adoptee or the person's other live
    // identity (#121) — so this check bites on both body shapes.)
    const callerIsGlobal = caller.role === 'global-finops' || caller.role === 'platform-admin'
    if (!callerIsGlobal && ownerRegionId !== ou.region_id) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Cross-region owner',
        data: {
          type: 'https://tokenscope.example.com/errors/cross-region-owner',
          title: 'Cross-region owner',
          status: 422,
          detail:
            'This teammate belongs to another region. Only global-finops / platform-admin may assign cross-region cost-centre owners.',
        },
      })
    }

    /*
     * ONE OWNER, ONE BUSINESS UNIT (owner ruling, 2026-08-10).
     *
     * `cou_owner` is 1..n owners per unit — which is fine and stays — but it was
     * also unbounded the OTHER way: one person could actively own several BUs.
     * That is not a shape the org has, and it breaks things that assume it does:
     * the manager-chain placement walk treats an owner of >1 active unit as
     * AMBIGUOUS and skips them entirely (`region-derivation.ts`), so a
     * multi-BU owner silently places nobody, and the picker's "(yours)" becomes
     * a list rather than a destination.
     *
     * Enforced HERE rather than by a partial-unique index, deliberately: Dev
     * already holds violations (several BUs are named "CTO Office" across
     * regions and one person owns more than one), and a migration that cannot
     * apply to the live database is not a constraint, it is an outage. The
     * index follows once `GET /admin/diagnostics/multi-bu-owners` reports clean.
     */
    /*
     * Serialised on the TEAMMATE, because the read below and the insert after it
     * are two statements: two concurrent grants for the same person and
     * different BUs would each see no existing ownership and both succeed. The
     * `(org_unit_id, teammate_id)` unique index cannot catch that — the rows
     * differ in org_unit_id. Same `principal` namespace the enrol path uses to
     * serialise one human.
     */
    await tx.execute(advisoryXactLock('principal', ownerTeammateId))

    /*
     * COUNTED ACROSS REGIONS, via the SECURITY DEFINER aggregate (mig 0111).
     *
     * A direct `SELECT … FROM cou_owner` is filtered by the `cou_owner_admin`
     * RLS policy, so a REGION admin cannot see an ownership a global admin
     * granted elsewhere — and would sail past this check and create exactly the
     * second BU it exists to prevent. `owner_active_unit_counts()` returns
     * counts only, never the hidden unit, which is why it can span regions
     * without leaking one.
     *
     * It already applies the same eligibility this rule means: real oids only,
     * cost-owning and non-retired units, active grants.
     */
    const [ownedElsewhere] = [
      ...(await tx.execute<{ n: string }>(sql`
        SELECT COALESCE(c.unit_count, 0)::text AS n
          FROM teammate t
          LEFT JOIN owner_active_unit_counts() c ON c.owner_oid = t.entra_oid
         WHERE t.id = ${ownerTeammateId}::uuid`)),
    ]
    /*
     * The count INCLUDES this unit when the caller is re-granting one they
     * already own (the `(org_unit_id, teammate_id)` unique index turns that
     * into its own 409 below), so the bar is "already owns one that is not this
     * one" — expressed as a count exceeding what this grant would justify.
     */
    const [alreadyHere] = [
      ...(await tx.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM cou_owner
         WHERE teammate_id = ${ownerTeammateId}::uuid
           AND org_unit_id = ${id}::uuid AND revoked_at IS NULL`)),
    ]
    if (Number(ownedElsewhere?.n ?? 0) - Number(alreadyHere?.n ?? 0) > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Already owns a Business Unit',
        data: {
          type: 'https://tokenscope.example.com/errors/already-owns-a-bu',
          title: 'Already owns a Business Unit',
          status: 409,
          // The unit is deliberately NOT named: it can be in a region this
          // caller may not see, and the count is the only thing safe to expose.
          detail:
            'This teammate already owns a Business Unit. A person may own at most one — revoke the existing ownership first. If you cannot see it, it is in another region; ask a global administrator.',
        },
      })
    }

    let created: { id: string } | undefined
    try {
      ;[created] = await tx
        .insert(couOwner)
        .values({ orgUnitId: id, teammateId: ownerTeammateId, assignedBy: caller.teammateId })
        .returning({ id: couOwner.id })
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23505': {
          title: 'Already an owner',
          detail: 'This teammate already actively owns this cost centre.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'cou-owner-assigned',
      actorTeammateId: caller.teammateId,
      subjectKind: 'org_unit',
      subjectId: id,
      payload: {
        teammate_id: ownerTeammateId,
        email: ownerEmail,
        org_unit_name: ou.display_name,
        identity_adopted: adopted,
        provisioned_from_directory: provisioned,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: created!.id,
      teammate_id: ownerTeammateId,
      email: ownerEmail,
      display_name: ownerDisplayName,
      identity_adopted: adopted,
      provisioned,
    }
  })
})
