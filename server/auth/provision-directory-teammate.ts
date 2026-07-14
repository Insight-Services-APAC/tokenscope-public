/*
 * provision-directory-teammate — find-or-provision a teammate from an Entra
 * DIRECTORY pick (an `oid` resolved via GET /admin/directory/search).
 *
 * Extracted from the identical block that lived inline in
 * `org-units/[id]/owners.post.ts` (cost-centre owner assignment) so the
 * project-member assignment path can reuse the SAME provisioning, not
 * duplicate the SQL. Both surfaces "pick a real person from the directory,
 * who may not be a teammate yet, and act on them" — see the canonical intent
 * in docs/design/provider-billing-attribution-model.md §"Directory is the
 * org-placement source of truth" ("Existence + placement come from the
 * directory, not from login… works for users who never log in, never emit").
 *
 * IDENTITY SAFETY: the caller resolves the oid against the directory
 * SERVER-SIDE (getDirectoryUserByOid) and passes the resolved DirectoryUser —
 * we never trust a client-supplied email / display name (spoofable). The
 * resulting teammate carries a REAL entra_oid from Graph, so it is NOT a
 * `bill:` / `provisional:` placeholder: ensureRealIdentity accepts it as-is.
 *
 * DUPLICATE-IDENTITY HANDLING (issue #121): one human can hold TWO live Entra
 * accounts sharing one mailbox (primary + a CLD/privileged secondary whose
 * `mail` is the same primary SMTP), and a bill-driven `bill:` placeholder can
 * already occupy the person's email slot (teammate_email_unique_real, mig
 * 0067: UNIQUE lower(email) WHERE NOT provisional). A blind INSERT guarded
 * only by ON CONFLICT (entra_oid) raised a raw 23505 → 500 on either. The
 * find-or-provision is therefore a CHECK-FIRST bind-or-adopt ladder
 * (mirroring jit-teammate.ts H2 and ensureRealIdentity's discipline):
 *
 *   0. A SECONDARY identity pick (tenant *.onmicrosoft.com UPN with a
 *      differing real mail) is refused 422, fail-closed: the manager-chain
 *      placement walk matches owners strictly by oid against Graph manager
 *      edges, which point at the PRIMARY account — provisioning/adopting with
 *      a secondary oid would mint a silently non-functional owner (the exact
 *      failure ensure-real-identity.ts exists to prevent) and brick the
 *      primary identity's future JIT sign-in on the email unique.
 *   1. An existing row by entra_oid is reused (idempotent re-pick).
 *   2. A `bill:` placeholder holding the email is ADOPTED in place (real oid,
 *      directory-sourced) — the admin pick IS the confirmation, exactly like
 *      ensureRealIdentity's bill-adopt. `provisional:` shadows are untouched
 *      (unverified claimed emails must sign in; they're outside the unique
 *      index anyway).
 *   3. A REAL-oid row holding the email is the person's OTHER live identity:
 *      resolve to it iff both sides' TRUE `mail` attributes match (same
 *      mailbox = same human; UPN-fallback equality is NOT identity — a UPN
 *      may equal a different human's mail). Anything unverifiable → 409,
 *      never a silent retarget, never a 500.
 *   4. Otherwise INSERT, savepoint-wrapped: this runs inside the caller's RLS
 *      transaction, and a caught 23505 would otherwise abort it (25P02). A
 *      race-window collision (concurrent JIT sign-in / bill-placement worker)
 *      rolls back to the savepoint and the ladder re-runs once — the racer's
 *      row is then found/adopted/resolved.
 *
 * Placement: the directory person is homed in their target region's `default`
 * BU (seed-ensured; falls back to the given `fallbackOrgUnitId`) with a
 * neutral `developer` role — the P&L / membership grant is independent of org
 * role, and the manager-chain re-enrichment worker refines the home later.
 * This mirrors the owners.post placement exactly.
 */
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { DirectoryUser } from '../azure/directory'
import { isExcludedUpn } from '../utils/directory-exclusions'
import { recordAuditEvent } from '../db/audit'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export interface ProvisionedDirectoryTeammate {
  teammateId: string
  email: string
  displayName: string | null
  regionId: string
  /** true when THIS call inserted the teammate row (vs. an existing one). */
  provisioned: boolean
  /** true when a `bill:` placeholder row was upgraded in place to the picked real oid. */
  adopted: boolean
}

export interface ProvisionDirectoryTeammateOpts {
  /** The region to home the new teammate in (its `default` BU). */
  regionId: string
  /**
   * Fallback org-unit id used only if the region has no `default` BU (shouldn't
   * happen post-seed). Callers pass a unit they already resolved in-region.
   */
  fallbackOrgUnitId: string
  /** Audit surface label (e.g. 'project-assign', 'cou-owner-assign'). */
  via: string
}

// Drizzle WRAPS the postgres-js error; the real `.code` rides on `.cause`
// (same walk as jit-teammate.ts / ensure-real-identity.ts). Only the TWO
// identity uniques count as "concurrent identity churn → retry the ladder";
// any other 23505 (a future constraint) must rethrow, not be masked behind a
// generic retry/409.
const IDENTITY_UNIQUES = ['teammate_entra_oid_key', 'teammate_email_unique_real']
function isIdentityUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e != null && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if (typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505') {
      const constraint = (e as { constraint_name?: string }).constraint_name
      return constraint != null && IDENTITY_UNIQUES.includes(constraint)
    }
  }
  return false
}

interface TeammateRow extends Record<string, unknown> {
  id: string
  email: string
  display_name: string | null
  region_id: string
  entra_oid: string
  is_active: boolean
}
const select = sql`SELECT id::text AS id, email, display_name, region_id::text AS region_id,
  entra_oid, is_active FROM teammate`

function assertAssignable(row: TeammateRow): void {
  if (!row.is_active) {
    throw createError({ statusCode: 422, statusMessage: 'Directory user is not an active teammate' })
  }
}

function identityCollision(detail: string): never {
  throw createError({
    statusCode: 409,
    statusMessage: 'Identity collision',
    data: {
      type: 'https://tokenscope.example.com/errors/identity-collision',
      title: 'Identity collision',
      status: 409,
      detail,
    },
  })
}

/**
 * Directory-pickability guard (issue #121). Refuse a pick whose UPN matches an
 * admin-configured exclusion pattern — privileged/service accounts (Rob's
 * `-cld@…onmicrosoft.com`) that never run the tools, never emit, never bill and
 * so must never become teammates, exactly like #EXT# guests. The rule is DATA
 * (directory_exclusion_pattern, admin-editable, portable) — `patterns` is
 * passed in by the caller, which loads it via loadDirectoryExclusionPatterns.
 * A fresh install has no patterns → excludes nobody (fail-open).
 *
 * Pure + synchronous (no Graph call). Call BEFORE the RLS transaction (all
 * handlers do). (#EXT# guests never reach here: getDirectoryUserByOid nulls
 * them → the handlers 404.)
 */
export function assertDirectoryIdentityPickable(dir: DirectoryUser, patterns: string[]): void {
  if (!isExcludedUpn(dir.upn, patterns)) return
  throw createError({
    statusCode: 422,
    statusMessage: 'Excluded directory identity',
    data: {
      type: 'https://tokenscope.example.com/errors/excluded-identity',
      title: 'Excluded directory identity',
      status: 422,
      detail: `${dir.upn ?? dir.email} matches a directory-exclusion pattern (privileged/service accounts are not assignable). Assign the person's standard account instead.`,
    },
  })
}

/**
 * Find-or-provision the teammate for a directory-resolved user, homed in
 * `opts.regionId`. Returns the canonical (existing, adopted, or just-inserted)
 * active teammate row plus `provisioned` / `adopted` flags. Audits
 * `teammate-provisioned` / `teammate-directory-adopted` accordingly.
 *
 * Callers MUST run assertDirectoryIdentityPickable(dir, patterns) BEFORE their
 * transaction — this function assumes the pick has passed the guard.
 *
 * `dir` MUST be the server-side directory resolution of the oid (never client
 * input). `actorTeammateId` is the admin/PM performing the action.
 */
export async function provisionDirectoryTeammate(
  tx: Tx,
  dir: DirectoryUser,
  actorTeammateId: string,
  opts: ProvisionDirectoryTeammateOpts,
): Promise<ProvisionedDirectoryTeammate> {
  const defRows = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM org_unit
    WHERE region_id = ${opts.regionId}::uuid AND code = 'default' AND retired_at IS NULL
    LIMIT 1
  `)
  const placementUnit = [...defRows][0]?.id ?? opts.fallbackOrgUnitId

  // Two passes: the second only runs after a savepoint-absorbed race (a
  // concurrent JIT sign-in / bill-placement worker landed the identity between
  // the checks and the INSERT), at which point the ladder finds the racer's row.
  for (let attempt = 0; attempt < 2; attempt++) {
    // 1. Existing row by oid — idempotent re-pick.
    const byOid = [...(await tx.execute<TeammateRow>(sql`${select} WHERE entra_oid = ${dir.oid} LIMIT 1`))][0]
    if (byOid) {
      assertAssignable(byOid)
      return { teammateId: byOid.id, email: byOid.email, displayName: byOid.display_name, regionId: byOid.region_id, provisioned: false, adopted: false }
    }

    // 2. Adopt a `bill:` placeholder holding the email — the pick confirms the
    // identity (mirrors ensureRealIdentity + jit-teammate H2). Never touches
    // `provisional:` shadows (provisional=TRUE). is_active is filtered IN the
    // UPDATE (don't mutate first and rely on rollback-by-throw): an inactive
    // placeholder falls through to step 3's prefix check for a clean 422.
    // Savepoint-wrapped like step 4's INSERT: setting entra_oid can hit
    // teammate_entra_oid_key if a concurrent writer lands dir.oid between
    // step 1 and here — that 23505 must roll back to the savepoint (not abort
    // the caller's RLS tx) and re-run the ladder against the racer's row.
    let adoptee: TeammateRow | undefined
    try {
      await tx.transaction(async (sp) => {
        const adoptedRows = await sp.execute<TeammateRow>(sql`
          UPDATE teammate SET entra_oid = ${dir.oid}, source = 'directory',
            display_name = COALESCE(display_name, ${dir.displayName}), last_sync_at = now()
          WHERE lower(email) = lower(${dir.email}) AND NOT provisional AND entra_oid LIKE 'bill:%'
            AND is_active = TRUE
          RETURNING id::text AS id, email, display_name, region_id::text AS region_id, entra_oid, is_active
        `)
        adoptee = [...adoptedRows][0]
      })
    } catch (err) {
      if (!isIdentityUniqueViolation(err)) throw err
      continue // same-oid race — step 1 finds the racer's row next pass
    }
    if (adoptee) {
      await recordAuditEvent(tx, {
        eventType: 'teammate-directory-adopted',
        actorTeammateId,
        subjectKind: 'teammate',
        subjectId: adoptee.id,
        payload: { oid: dir.oid, email: adoptee.email, via: opts.via },
      })
      return { teammateId: adoptee.id, email: adoptee.email, displayName: adoptee.display_name, regionId: adoptee.region_id, provisioned: false, adopted: true }
    }

    // 3. A non-placeholder row already holds this email under a DIFFERENT oid.
    // Privileged twins are excluded up-front (assertDirectoryIdentityPickable),
    // so this is a duplicate / data anomaly, not a legitimate dual identity —
    // surface a clean, admin-actionable 409 (or a 422 for a placeholder holder)
    // rather than letting step 4 raise a raw 23505 → 500.
    const collider = [...(await tx.execute<TeammateRow>(sql`
      ${select} WHERE lower(email) = lower(${dir.email}) AND NOT provisional LIMIT 1
    `))][0]
    if (collider) {
      if (collider.entra_oid.startsWith('bill:') || collider.entra_oid.startsWith('provisional:')) {
        throw createError({
          statusCode: 422,
          statusMessage: 'Unresolvable placeholder identity',
          data: {
            type: 'https://tokenscope.example.com/errors/placeholder-identity',
            title: 'Unresolvable placeholder identity',
            status: 422,
            detail: `${collider.email} is held by an inactive or unconfirmed placeholder record. Resolve that teammate record before assigning.`,
          },
        })
      }
      identityCollision(
        `${dir.email} is already held by a different directory identity. Resolve the duplicate teammate before assigning.`,
      )
    }

    // 4. Provision. Savepoint-wrapped (nested tx): a race-window 23505 on the
    // email unique must not abort the caller's RLS transaction (25P02).
    // ON CONFLICT (entra_oid) still absorbs the same-oid race quietly.
    let inserted: TeammateRow | undefined
    try {
      await tx.transaction(async (sp) => {
        const insRows = await sp.execute<TeammateRow>(sql`
          INSERT INTO teammate (entra_oid, email, display_name, role, region_id, org_unit_id, source)
          VALUES (${dir.oid}, ${dir.email}, ${dir.displayName}, 'developer', ${opts.regionId}::uuid, ${placementUnit}::uuid, 'directory')
          ON CONFLICT (entra_oid) DO NOTHING
          RETURNING id::text AS id, email, display_name, region_id::text AS region_id, entra_oid, is_active
        `)
        inserted = [...insRows][0]
      })
    } catch (err) {
      if (!isIdentityUniqueViolation(err)) throw err
      continue // email-unique race — re-run the ladder against the racer's row
    }
    if (!inserted) continue // entra_oid race (DO NOTHING) — step 1 finds it next pass

    await recordAuditEvent(tx, {
      eventType: 'teammate-provisioned',
      actorTeammateId,
      subjectKind: 'teammate',
      subjectId: inserted.id,
      payload: { oid: dir.oid, email: dir.email, source: 'directory', via: opts.via },
    })
    return { teammateId: inserted.id, email: inserted.email, displayName: inserted.display_name, regionId: inserted.region_id, provisioned: true, adopted: false }
  }

  // Two full passes without landing: concurrent identity churn on both attempts.
  identityCollision(
    `${dir.email} changed concurrently while provisioning (another sign-in or placement worker). Retry the assignment.`,
  )
}
