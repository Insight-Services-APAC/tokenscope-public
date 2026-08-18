/*
 * POST /api/v1/admin/workers/{name}/run — admin-authed, on-demand worker trigger.
 *
 * The SAME in-process dispatch the cron uses (dispatchWorker), but gated by an
 * admin SESSION instead of the machine-to-machine HMAC. This exists because
 * workers already run in the web-app process — the Container Apps cron job is just
 * `cron-trigger.mjs` signing an HMAC POST to /internal/run-worker; there is no
 * separate worker runtime to reach. So an admin "Run now" button is exactly the
 * same execution, differing only in the auth surface.
 *
 * Why an admin can NOT run every worker: the UI is a NARROWER surface than the
 * cron. Only UI_TRIGGERABLE_WORKERS (the reconciliation / identity / placement
 * family) are exposed — idempotent workers an admin has a real reason to force.
 * Destructive / money-settling workers stay cron/HMAC-only. An un-safelisted name
 * 404s (not 403) so the button surface isn't a probe oracle for the full registry.
 *
 * Concurrency: dispatchWorker holds the ING-3 single-flight lock, so a click while
 * the cron is mid-run (or a double-click) gets a clean 409 no-op, never a
 * duplicate run.
 *
 * Attribution: the trigger is audited BEFORE any side effects, RLS-correct
 * (withRequestRls sets app.user_role from the session so the audit_event admin-only
 * policy is satisfied under a future non-owner DB role) and FAIL-CLOSED — a
 * (possibly ledger-writing) worker never runs unattributed: if the audit write
 * fails we throw before dispatching. The audit row is the actor/intent; the
 * worker_run ledger carries the OUTCOME (status/duration/result/runId), so we don't
 * duplicate (or size-cap-bust) the result here.
 *
 * RBAC: requireRole(global-finops) + assertSameOrigin. NOT region-scoped `admin`:
 * every safelisted worker operates GLOBALLY (no region param — identity-sync sweeps
 * the whole enterprise, placement-sync drains the whole queue, reconciliation-sync
 * reconciles all scopes), so forcing one exceeds a region admin's scope. Only
 * global-finops + platform-admin (which requireRole always admits) may trigger.
 */
import { createError, defineEventHandler, getRouterParam, getRequestIP, getHeader } from 'h3'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { getWorkerDb } from '../../../../../db/worker-db'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { dispatchWorker } from '../../../../../workers/dispatch'
import { getWorker, UI_TRIGGERABLE_WORKERS } from '../../../../../workers/registry'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'global-finops')
  assertSameOrigin(event)

  const name = getRouterParam(event, 'name')
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'Missing worker name' })
  }
  // Narrow UI surface. 404 (not 403) so the button set isn't an existence oracle
  // for the wider cron-only registry.
  if (!UI_TRIGGERABLE_WORKERS.has(name)) {
    throw createError({ statusCode: 404, statusMessage: `Worker '${name}' is not available to run from the UI.` })
  }
  // Defensive: the safelist is unit-guarded to hold only real workers, but a drift
  // would otherwise 500 inside dispatch — fail clean instead.
  const entry = getWorker(name)
  if (!entry) {
    throw createError({ statusCode: 404, statusMessage: `Unknown worker: ${name}` })
  }

  // TWO LANES, deliberately (docs/design/rls-enforcement.md §2). The AUDIT write
  // below stays on the REQUEST lane (`withRequestRls`), because it records what
  // THIS admin did and must be scoped to them. The WORKER runs on the worker
  // lane's pool, which carries the estate-wide `app.user_role=global-finops`
  // GUC: every UI-triggerable worker operates globally (identity-sync sweeps the
  // enterprise, reconciliation-sync reconciles all scopes), so under FORCE it
  // must not inherit the triggering admin's scope. requireRole already limits
  // this route to global-finops/platform-admin, so this widens nothing — it
  // stops the scope being an ambient consequence of which pool the code landed
  // on.
  const db = await getWorkerDb()
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  // Attribute the trigger BEFORE any side effects — RLS-correct + fail-closed so a
  // ledger-writing worker never runs unattributed. A concurrent-run 409 (below)
  // still leaves this "attempted" row, which is truthful.
  await withRequestRls(event, (tx) =>
    recordAuditEvent(tx, {
      eventType: 'admin-run-worker',
      actorTeammateId: caller.teammateId,
      // subject_id is a uuid column; a worker has no uuid, so the worker name rides
      // in the payload (subjectKind labels the subject class). Actor email is NOT
      // duplicated here — the audit viewer derives it live via LEFT JOIN teammate on
      // actor_teammate_id, so a copy would just go stale in this append-only row.
      subjectKind: 'worker',
      payload: { worker: name, trigger: 'ui' },
      ipAddress: ip,
      userAgent: ua,
    }),
  )

  // No opts from the UI: deepRescan is a deliberate cron-only recovery lever.
  return dispatchWorker(db, entry)
})
