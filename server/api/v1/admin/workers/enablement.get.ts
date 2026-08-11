/*
 * GET /api/v1/admin/workers/enablement — every scheduled worker with its on/off state.
 *
 * The read side of the admin kill-switch (mig 0090). Returns the FULL registry, not
 * just the rows that exist, because an absent row means ENABLED — an admin needs to
 * see the whole fleet and its state, not a list of exceptions they have to invert
 * in their head.
 *
 * RBAC: admin / global-finops, matching the rest of the admin surface.
 */
import { defineEventHandler } from 'h3'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { WORKERS } from '../../../../workers/registry'
import { listWorkerEnablement } from '../../../../workers/enablement'
import { unscheduledReason } from '../../../../../shared/workers/unscheduled'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')

  return withRequestRls(event, async (db) => {
    const explicit = new Map((await listWorkerEnablement(db)).map((r) => [r.workerName, r]))
    return {
      workers: WORKERS.map((w) => {
        const row = explicit.get(w.name)
        // A registered worker with no cron NEVER runs. Report that rather than a
        // cron the operator would read as its live schedule — the lockstep test
        // keeps this list honest against worker-jobs.bicep.
        const noCronReason = unscheduledReason(w.name)
        return {
          name: w.name,
          description: w.description,
          scheduled: noCronReason === null,
          unscheduledReason: noCronReason,
          // Only meaningful when scheduled; the lockstep test asserts it equals
          // the deployed cron, so it is the live schedule and not an aspiration.
          // Null ONLY when unscheduled — recommendedCron is non-nullable on
          // WorkerEntry, so a `?? null` here would just obscure that this is the
          // single reason the field is ever suppressed.
          recommendedCron: noCronReason === null ? w.recommendedCron : null,
          // Absent row ⇒ enabled (mig 0090 contract).
          enabled: row ? row.enabled : true,
          reason: row?.reason ?? null,
          updatedAt: row?.updatedAt ?? null,
          // Distinguishes "explicitly left on" from "never touched" in the UI.
          explicit: Boolean(row),
        }
      }),
    }
  })
})
