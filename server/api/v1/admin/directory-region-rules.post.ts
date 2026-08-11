/*
 * POST /api/v1/admin/directory-region-rules — upsert a directory placement rule
 * (mig 0089, extended by mig 0112).
 *
 * ONE rule shape, TWO targets:
 *   { region_id }    "when a user's <attribute> = <value>, their region is R"
 *   { org_unit_id }  "…their cost centre is U"   ← spec C5
 *
 * The unit form is the SAME table, the same matcher and the same upsert key. It
 * is not a second rule engine: `directory_region_rule.org_unit_id` is one nullable
 * column, `region_id` is derived from the unit (and held to it by the composite FK
 * in mig 0112), and `mapAttributesToRegion` resolves both. Upsert keyed on
 * (attribute, match_value) so re-adding re-points the target and refreshes casing
 * — a value cannot mean two different things at once.
 *
 * ── WHO MAY WRITE WHICH ───────────────────────────────────────────────────────
 * A REGION rule is cross-region placement config: it decides which region a
 * never-logged-in person lands in, so it stays GLOBAL-roles-only, exactly as it
 * was.
 *
 * A UNIT rule places people into ONE region's cost centre, so a region admin may
 * write it — for their OWN region, which is `requireRegionScope` against the
 * TARGET UNIT's region. That is the same check `bulk-place` runs against the same
 * kind of target, deliberately: "may this caller place people into this unit" has
 * one answer, not one per endpoint.
 *
 * ── AND WHAT THEY MAY OVERWRITE ───────────────────────────────────────────────
 * The upsert is the part a scope check on the NEW target alone does not cover. If
 * (attribute, match_value) already has a rule, writing it re-points whatever is
 * there — so a region admin could otherwise hijack another region's rule, or
 * convert a global region rule into a rule that feeds their own cost centre,
 * simply by naming the same value. So the EXISTING row is locked and authorised
 * too: a region admin may only overwrite a unit rule they already administer, and
 * never a region rule.
 *
 * That authorisation is only worth anything if it cannot be skipped by ARRIVING
 * FIRST. `FOR UPDATE` locks a row that exists; when the key is still free it locks
 * nothing at all, so two regions can both read "no rule here", both skip the check
 * that has nothing to check, and the loser's ON CONFLICT DO UPDATE silently
 * re-points the winner's rule. The upsert KEY is therefore taken as a
 * transaction-scoped advisory lock (LOCK_NAMESPACE.directoryRule) before the read
 * — the no-row-yet case is exactly the one a row lock cannot cover, and it is the
 * one that bypasses the authorisation.
 *
 * ── THE TARGET MUST BE ABLE TO RECEIVE SPEND ──────────────────────────────────
 * `assertCostOwningTarget` — the same function bulk-place uses, with the same
 * sentences. A rule pointing at a non-cost-owning or retired unit would place
 * people somewhere their spend still reaches no cost centre, which is the exact
 * illusion this whole slice exists to remove.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import { recordAuditEvent } from '../../../db/audit'
import { advisoryXactLock } from '../../../db/advisory-lock'
import { assertCostOwningTarget } from '../../../db/place-teammate'
import { isPlatformAdmin } from '../../../../shared/auth/roles'
import {
  isRegionAttributeKey,
  isMatchMode,
  normalizeMatchValue,
} from '../../../../shared/placement/region-attributes'

const Body = z
  .object({
    attribute: z.string().refine(isRegionAttributeKey, 'unknown region attribute'),
    match_mode: z.string().refine(isMatchMode, "match_mode must be 'exact' or 'prefix'").default('exact'),
    match_value: z.string().trim().min(1).max(200),
    region_id: z.string().uuid().optional(),
    /** A cost-owning unit. Its region becomes the rule's region — never both. */
    org_unit_id: z.string().uuid().optional(),
  })
  .refine(
    (b) => Boolean(b.region_id) !== Boolean(b.org_unit_id),
    'supply exactly one of region_id (a region rule) or org_unit_id (a unit rule)',
  )

function refuse(status: number, detail: string): never {
  throw createError({
    statusCode: status,
    statusMessage: detail,
    data: {
      type:
        status === 403
          ? 'https://tokenscope.example.com/errors/forbidden'
          : 'https://tokenscope.example.com/errors/unprocessable',
      title: status === 403 ? 'Forbidden' : 'Unprocessable',
      status,
      detail,
    },
  })
}

export default defineEventHandler(async (event) => {
  // Authenticate at the wider surface first, then narrow by what is being written:
  // a REGION rule still demands a global role, checked below before anything reads
  // the database.
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const orgWide = isPlatformAdmin(caller.role) || caller.role === 'global-finops'
  if (!body.org_unit_id && !orgWide) {
    refuse(
      403,
      'A region rule sets which REGION people land in, which is org-wide placement configuration — global finance access is required. To route people into one of your own cost centres, create a unit rule instead.',
    )
  }
  const matchValue = normalizeMatchValue(body.match_value)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    /*
     * THE UPSERT KEY, LOCKED BEFORE ANYTHING READS IT. Held to commit, so from
     * here to the INSERT this transaction is the only one that can decide what
     * `(attribute, match_value)` points at — including while it is still free.
     * Taken first, before the row locks below, so every writer of this key
     * acquires it in the same order and two racing rule writes queue instead of
     * deadlocking.
     */
    await tx.execute(advisoryXactLock('directoryRule', `${body.attribute}:${matchValue}`))

    /*
     * Resolve the TARGET first: a unit rule's region is the unit's own, so it is
     * read rather than supplied (and the mig-0112 composite FK stops the stored
     * pair drifting apart afterwards). FOR SHARE, so the unit cannot be retired
     * or un-flagged between the assert below and the insert — the same lock, for
     * the same reason, as the placement write.
     */
    let regionId: string
    let orgUnitId: string | null = null
    if (body.org_unit_id) {
      const unitRows = await tx.execute<{ region_id: string; display_name: string }>(sql`
        SELECT region_id::text AS region_id, display_name
        FROM org_unit WHERE id = ${body.org_unit_id}::uuid LIMIT 1 FOR SHARE
      `)
      const unit = [...unitRows][0]
      // 422 rather than 404: the id came from a picker, and telling an
      // unauthorised caller "no such unit" apart from "not your unit" is an
      // existence oracle. Both land on the same refusal.
      if (!unit) refuse(422, 'org_unit_id must reference an org unit that exists.')
      await requireRegionScope(event, unit.region_id)
      await assertCostOwningTarget(tx, body.org_unit_id)
      regionId = unit.region_id
      orgUnitId = body.org_unit_id
    } else {
      regionId = body.region_id!
    }

    const regionRows = await tx.execute<{ id: string; code: string }>(sql`
      SELECT id::text AS id, code FROM region WHERE id = ${regionId}::uuid LIMIT 1
    `)
    const regionRow = [...regionRows][0]
    if (!regionRow) refuse(422, 'Region not found')

    /*
     * The row this upsert would REPLACE. Locked, because the authorisation below
     * is a statement about it and READ COMMITTED would otherwise let a concurrent
     * write change the target between the check and the ON CONFLICT.
     */
    const existingRows = await tx.execute<{ id: string; region_id: string; org_unit_id: string | null }>(sql`
      SELECT id::text AS id, region_id::text AS region_id, org_unit_id::text AS org_unit_id
      FROM directory_region_rule
      WHERE attribute = ${body.attribute} AND match_value = ${matchValue}
      LIMIT 1 FOR UPDATE
    `)
    const existing = [...existingRows][0]
    if (existing && !orgWide) {
      if (!existing.org_unit_id) {
        refuse(
          403,
          `“${body.match_value.trim()}” is already used by an org-wide region rule. Re-pointing it would change which region everyone matching it lands in, so it takes global finance access.`,
        )
      }
      // A unit rule they must already administer — same scope check, applied to
      // what is being overwritten rather than only to what replaces it.
      await requireRegionScope(event, existing.region_id)
    }

    const upserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO directory_region_rule (attribute, match_mode, match_value, match_value_raw, region_id, org_unit_id, created_by, created_at)
      VALUES (${body.attribute}, ${body.match_mode}, ${matchValue}, ${body.match_value.trim()}, ${regionId}::uuid, ${orgUnitId}::uuid, ${caller.teammateId}::uuid, now())
      ON CONFLICT (attribute, match_value) DO UPDATE
        SET region_id = EXCLUDED.region_id,
            org_unit_id = EXCLUDED.org_unit_id,
            match_mode = EXCLUDED.match_mode,
            match_value_raw = EXCLUDED.match_value_raw,
            updated_at = now()
      RETURNING id::text AS id
    `)
    const row = [...upserted][0]!

    await recordAuditEvent(tx, {
      eventType: 'region-rule-set',
      actorTeammateId: caller.teammateId,
      subjectKind: 'directory_region_rule',
      subjectId: row.id,
      payload: {
        attribute: body.attribute,
        match_mode: body.match_mode,
        match_value: matchValue,
        region_id: regionId,
        region_code: regionRow.code,
        org_unit_id: orgUnitId,
        // What it replaced, so an overwrite is legible as one in the trail.
        previous_region_id: existing?.region_id ?? null,
        previous_org_unit_id: existing?.org_unit_id ?? null,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: row.id,
      attribute: body.attribute,
      match_mode: body.match_mode,
      match_value: matchValue,
      match_value_raw: body.match_value.trim(),
      region_id: regionId,
      region_code: regionRow.code,
      org_unit_id: orgUnitId,
    }
  })
})
