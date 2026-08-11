/*
 * Budget-alert worker — emits `over-budget` inbox items for projects whose
 * MTD attributed cost has exceeded their current baseline+top-up allocation.
 *
 * Why this exists: prior to MVP-Final convergence, inbox over-budget items
 * were hard-coded in `drizzle/seed.ts` while the homepage rendered live
 * numbers from `attribution_record + allocation`. The two surfaces diverged
 * — homepage said "Healthy" while the inbox said "$210 over". This worker
 * is the producer that closes that gap: it calls the SAME `completeProjectSpend`
 * the project page, the /projects cards and the budget editor call, with the
 * same window and the same options, so the surfaces agree by construction
 * rather than by coincidence (server/usage/complete-spend.ts).
 *
 * Mirrors `runReconciliation`'s shape:
 *   - Pure SQL scan, no external clients.
 *   - Idempotency-check before dispatch (no duplicates within a month).
 *   - Uses dispatchInbox — the dispatcher picks recipients (project's CoU
 *     teammates) via its own routing rule. We do NOT specify a recipient.
 *
 * Body field contract: matches app/components/inbox/DrawerBodyOverBudget.vue
 * exactly — `project`, `usedUsd`, `capUsd`, `overBy`, `otelPct`, `anthroPct`.
 *
 * On otelPct / anthroPct: both are now the REAL arm split of the figure that
 * tripped the alert, taken from the same `completeProjectSpend` row (arm 1
 * `otel-emitted` vs arm 2 `api-reconciled`). See the loop below for why the old
 * hard-coded 1.0/0.0 was wrong.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox } from '../notifications/dispatch'
import { monthStartIso as monthStartIsoFor, monthToDateWindow, nextMonthStartIso } from '../utils/period'
import { completeProjectSpend } from '../usage/complete-spend'

export interface BudgetAlertResult {
  projectsScanned: number
  alertsDispatched: number
  skippedExisting: number
}

interface ProjectRow extends Record<string, unknown> {
  project_id: string
  project_code: string
  display_name: string
  cap_usd: string
}

export async function runBudgetAlert(
  db: PostgresJsDatabase<typeof schema>,
  opts?: { now?: Date },
): Promise<BudgetAlertResult> {
  const now = opts?.now ?? new Date()
  const monthStartIso = monthStartIsoFor(now)
  /*
   * TWO windows, deliberately, because the alert asks two different questions
   * (server/utils/period.ts):
   *   spendWindow — MONTH TO DATE `[monthStart, now)`. What has been spent. A
   *     row dated later this month has not been spent yet, and counting it
   *     would page a PM for an overage that has not happened.
   *   nextMonthStartIso — the CALENDAR-month upper bound, used ONLY for the
   *     allocation overlap below. A top-up effective on the 28th is real budget
   *     for the month on the 3rd, so the cap must see the whole month even
   *     though the spend must not.
   */
  const spendWindow = monthToDateWindow(now)
  const monthEndIso = nextMonthStartIso(now)

  // Per-project MTD spend and the current allocation cap (baseline + top-up
  // effective at month-start; burst excluded — matches usage.get.ts and the
  // allocation_total_usd contract).
  //
  // Only projects with at least one allocation row (cap > 0) are
  // candidates; a project with no allocation has no over-budget concept.
  //
  // completeProjectSpend is THE project-spend definition (server/usage/
  // complete-spend.ts) — the SAME call the project page, the /projects cards,
  // the budget editor and the manager rollup make, with the SAME window and the
  // SAME named `excludeProvisional` option. That is deliberate: the alert that
  // pages a PM must be computed on the number they will see when they click
  // through, or "Manage budget →" walks them from one figure to another at the
  // exact moment they decide whether to extend.
  /*
   * ── Mid-recompute protection (mig 0119, design §10) ───────────────────────
   *
   * This worker runs on its own hourly cron, independently of the usage
   * reconciliation that recomputes the §A residual. The residual reaches this
   * figure through `v_complete_usage` arm 2, and the emitting-identity design
   * makes residuals GROW (self-billed OTel leaves the subtrahend), so a
   * threshold can be crossed while a recompute is in flight.
   *
   * The protection is implemented WHERE THE PARTIAL STATE IS PRODUCED, not
   * here: `reconcileUnaccountedUsage` now writes its upsert and both orphan
   * passes in ONE transaction, so this read cannot land between them. Putting a
   * guard in this worker instead would have protected the alert and left every
   * report and project page exposed to the same intermediate state.
   *
   * WHAT THAT GUARANTEES for this worker: the residual component of every
   * figure below is a committed generation of the reconciliation — never a
   * half-applied one.
   *
   * WHAT IT DOES NOT GUARANTEE, and this worker must not be read as claiming:
   *   - It spans only `unaccounted_usage`. `over_emission`, the rollups and the
   *     joiner's own writes are separate transactions, so a figure assembled
   *     from more than one of those can still mix generations. The design's
   *     full answer is a generation-carrying restatement window (§10); this is
   *     not that, and does not pretend to be.
   *   - It does not suppress a LEGITIMATE page. Once the corrected figures are
   *     committed, a project genuinely over its cap pages on the next tick —
   *     that is §10's "re-evaluate once", not a leak. There is deliberately no
   *     developer-facing "we corrected this" notice: the figure was wrong and is
   *     now right.
   *   - Cutover is gradual, not a big bang, which is what keeps the exposure
   *     small: the lane is stamped at join, so a `(teammate, day, tool)` cell is
   *     held on the OLD operand until every row in it is stamped
   *     (server/usage/corroborated-otel.ts). In practice figures move a day at a
   *     time as fully-stamped days accumulate, rather than all at once.
   */
  const spendByProject = await completeProjectSpend(db, spendWindow, { excludeProvisional: true })

  // Cap = baseline + top-up allocations OVERLAPPING the month (`&&`), not merely
  // containing month-start (`@>`). A mid-month top-up is real budget: with `@>` it
  // was invisible here while the dev's own usage page (which uses `&&`) counted it,
  // so the worker could page "over budget" against a cap the PM had already raised.
  const rows = await db.execute<ProjectRow>(
    sql`
      SELECT p.id::text   AS project_id,
             p.code       AS project_code,
             p.display_name AS display_name,
             -- Cap = the ONE baseline in force at month-start + EVERY top-up
             -- overlapping the month. The two kinds need different window rules:
             --   baseline: point-containment (@>). Baselines are non-overlapping
             --     but SUCCESSIVE ones are allowed (change the budget mid-month →
             --     [May1,May15) + [May15,Jun1)). Range-overlap would SUM both and
             --     silently double the cap, suppressing real over-budget pages.
             --   top-up: range-overlap (&&). Top-ups stack by design, and a
             --     mid-month top-up is real budget that must count — with @> it
             --     was invisible here while the dev's own page counted it, so the
             --     worker could page against a cap the PM had already raised.
             COALESCE((
               SELECT SUM(al.budget_usd)
                 FROM allocation al
                WHERE al.scope_type = 'project'
                  AND al.scope_id = p.id
                  AND (
                    (al.allocation_kind = 'baseline'
                       AND al.effective @> ${monthStartIso}::timestamptz)
                    OR
                    (al.allocation_kind = 'top-up'
                       AND al.effective && tstzrange(${monthStartIso}::timestamptz, ${monthEndIso}::timestamptz, '[)'))
                  )
             ), 0)::text AS cap_usd
        FROM project p
       WHERE EXISTS (
              SELECT 1 FROM allocation al
               WHERE al.scope_type = 'project'
                 AND al.scope_id = p.id
                 AND (
                   (al.allocation_kind = 'baseline' AND al.effective @> ${monthStartIso}::timestamptz)
                   OR
                   (al.allocation_kind = 'top-up'
                      AND al.effective && tstzrange(${monthStartIso}::timestamptz, ${monthEndIso}::timestamptz, '[)'))
                 )
             )
    `,
  )

  let alertsDispatched = 0
  let skippedExisting = 0
  const projectsScanned = rows.length

  for (const r of rows) {
    const usedUsd = spendByProject.get(r.project_id)?.costUsd ?? 0
    const capUsd = Number(r.cap_usd)
    if (capUsd <= 0) continue
    if (usedUsd <= capUsd) continue

    // Idempotency: skip if ANY recipient has an unresolved over-budget item
    // for this project created since month-start. Tradeoff: per-recipient
    // scoping re-fires when the dispatcher fans out to a manager added
    // after the first alert (false-positive); project-wide scoping
    // silently fails to backfill a teammate added to the CoU mid-month
    // (false-negative). We pick project-wide because the dispatcher's
    // fan-out target is stable enough for the demo; a per-recipient
    // dispatch_log is the right production answer and is tracked as a
    // follow-up.
    const existing = await db.execute<{ id: string }>(
      sql`
        SELECT id::text AS id FROM inbox_item
         WHERE category = 'over-budget'
           AND related_entity_kind = 'project'
           AND related_entity_id = ${r.project_id}::uuid
           -- ANY item this month, regardless of ack_state. Counting only OPEN
           -- states meant a DISMISSED or RESOLVED item stopped suppressing the
           -- next tick, so a still-over project re-paged its PM + CoU owner +
           -- every contributor on EVERY tick for the rest of the month. Dismiss
           -- must stick: one over-budget item per project per month, full stop.
           AND created_at >= ${monthStartIso}::timestamptz
         LIMIT 1
      `,
    )
    if (existing.length > 0) {
      skippedExisting += 1
      continue
    }

    const overBy = usedUsd - capUsd
    // "How we know" (DrawerBodyOverBudget): the REAL arm split of the figure
    // that tripped the alert. This used to be hard-coded otelPct=1.0 /
    // anthroPct=0.0 on the claim that a per-project API split "isn't directly
    // computable" — untrue since this worker moved to the §A lane: arm 2 IS the
    // reconciled API−OTel gap, per project, and it is exactly the share the PM
    // most needs disclosed (it is the part `attribution_aggregate` never had).
    const spend = spendByProject.get(r.project_id)
    // ONE denominator, guarded once. This branch only runs when usedUsd > capUsd,
    // and an allocation is non-negative, so usedUsd > 0 is already implied — the
    // per-share `usedUsd > 0` tests it replaced were each individually dead, which
    // is what static analysis flagged. The guard is not dead, though: it is the
    // only thing standing between a nonsensical negative cap and a NaN percentage
    // on a PM's alert. Kept as a floor rather than repeated as a test.
    const denom = usedUsd > 0 ? usedUsd : 1
    const otelPct = (spend?.otelUsd ?? 0) / denom
    const anthroPct = (spend?.reconciledUsd ?? 0) / denom

    const dispatched = await dispatchInbox(db, {
      category: 'over-budget',
      subject: `${r.display_name} is $${overBy.toFixed(0)} over allocation`,
      body: {
        project: r.project_code,
        usedUsd,
        capUsd,
        overBy,
        otelPct,
        anthroPct,
      },
      relatedEntityKind: 'project',
      relatedEntityId: r.project_id,
      // Same clock as this run's spend window — the contributor routing
      // must see the spend that triggered the alert.
      now,
    })
    if (dispatched.length > 0) {
      alertsDispatched += 1
    }
  }

  return { projectsScanned, alertsDispatched, skippedExisting }
}
