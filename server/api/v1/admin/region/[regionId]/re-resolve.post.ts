/*
 * POST /api/v1/admin/region/{regionId}/re-resolve — apply the current placement
 * configuration to the people who already exist in THIS region (spec C7).
 *
 * THE GAP THIS CLOSES. `region-reenrichment` already re-derives placements, but it
 * is a global cron worker and `POST /admin/workers/{name}/run` gates the manual
 * trigger on `global-finops` — deliberately, because every safelisted worker is
 * global and forcing one exceeds a region admin's scope. So the region admin who
 * just added a cost-centre owner had no way to apply it to anyone. This endpoint
 * is that derivation, region-scoped, which is what makes it a region admin's to
 * run.
 *
 * ── AUTHORISATION ─────────────────────────────────────────────────────────────
 * `requireRole('admin','global-finops')` then `requireRegionScope(regionId)` —
 * the same pair every other region-scoped admin surface uses, and the same one
 * bulk-place applies. A region admin cannot re-resolve another region.
 *
 * That check is sufficient here only because of what the callable will and will
 * not do (server/reconciliation/region-reresolve.ts): it moves people ONLY onto
 * cost-owning units inside `regionId`, so authority over the region is authority
 * over every row it can write. It never writes another region's rows, never
 * de-places anyone to the global bucket, and never touches a teammate with a live
 * instance or OAuth token — that last one is the worker's revoke-cascade safety
 * predicate, shared verbatim (server/reconciliation/rehome-safety.ts), not
 * re-stated here.
 *
 * ── DRY RUN IS THE DEFAULT ────────────────────────────────────────────────────
 * `dry_run` defaults to TRUE. A caller that omits it gets the preview, not the
 * write. Placement is spend attribution; the failure mode of "the flag defaulted
 * the other way" is a few hundred people silently re-homed by a request that
 * meant to ask a question.
 *
 * ── BATCHED ───────────────────────────────────────────────────────────────────
 * `limit` caps one pass (default 50, max 200) because each candidate can cost a
 * Graph manager hop and this runs inside an HTTP request — the same ~120s gateway
 * ceiling that forces the long workers to chunk. The response carries `remaining`
 * so the caller knows another pass is needed and can show progress.
 *
 * ── AUDITED, AND ONLY WHEN IT WRITES ──────────────────────────────────────────
 * A dry run writes nothing at all — no audit row, no directory snapshot, no
 * attempt stamp — so "I looked" and "I changed 40 people's cost centre" are never
 * the same row in the log.
 *
 * EVERY committing pass writes exactly one audit event, INCLUDING one that moved
 * nobody, because a committing pass that moves nobody is still a write: it
 * refreshes directory snapshots and stamps the batching cursor on everyone it
 * looked at. Auditing only `moved > 0` left those writes untraceable while the
 * comment beside it claimed committing writes were audited. The counts in the
 * payload say which kind of pass it was.
 */
import { defineEventHandler, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { runRegionReresolve } from '../../../../../reconciliation/region-reresolve'

/** One pass. Sized to stay well inside the request/gateway budget. */
export const RE_RESOLVE_MAX_BATCH = 200

const Body = z.object({
  dry_run: z.boolean().default(true),
  limit: z.number().int().positive().max(RE_RESOLVE_MAX_BATCH).default(50),
})

export const RE_RESOLVE_AUDIT_EVENT = 'region-placement-re-resolved'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const regionId = requireUuidParam(event, 'regionId')
  await requireRegionScope(event, regionId)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null
  const batchId = randomUUID()

  return await withRequestRls(event, async (tx) => {
    const result = await runRegionReresolve(tx, {
      regionId,
      dryRun: body.dry_run,
      limit: body.limit,
    })

    if (!body.dry_run) {
      await recordAuditEvent(tx, {
        eventType: RE_RESOLVE_AUDIT_EVENT,
        actorTeammateId: caller.teammateId,
        actorSystem: 'admin-ui',
        subjectKind: 'region',
        subjectId: regionId,
        payload: {
          batchId,
          considered: result.considered,
          moved: result.moved,
          alreadyCorrect: result.alreadyCorrect,
          unresolved: result.unresolved,
          outOfRegion: result.outOfRegion,
          errors: result.errors,
          skipped: result.skipped,
          remaining: result.remaining,
          // The individual placements are recoverable from the moves list here;
          // the per-teammate rows a manual placement writes are deliberately NOT
          // duplicated, because this action's subject is the region.
          moved_teammate_ids: result.moves.map((m) => m.teammateId),
        },
        ipAddress: ip,
        userAgent: ua,
      })
    }

    return {
      region_id: result.regionId,
      dry_run: result.dryRun,
      batch_id: body.dry_run ? null : batchId,
      routes: {
        unambiguous_owners: result.routes.unambiguousOwners,
        unit_rules: result.routes.unitRules,
        viable: result.routes.viable,
      },
      candidates: result.candidates,
      considered: result.considered,
      moved: result.moved,
      already_correct: result.alreadyCorrect,
      unresolved: result.unresolved,
      out_of_region: result.outOfRegion,
      errors: result.errors,
      /** Decided, then refused at write time because something changed under it. */
      skipped: result.skipped,
      snapshot_errors: result.snapshotErrors,
      remaining: result.remaining,
      /** > 0 remaining ⇒ run it again; the batch is a pass, not the whole job. */
      more: result.remaining > 0,
      moves: result.moves.map((m) => ({
        teammate_id: m.teammateId,
        email: m.email,
        display_name: m.displayName,
        from_org_unit_id: m.fromOrgUnitId,
        from_display_name: m.fromDisplayName,
        to_org_unit_id: m.toOrgUnitId,
        to_display_name: m.toDisplayName,
        via: m.via,
      })),
    }
  })
})
