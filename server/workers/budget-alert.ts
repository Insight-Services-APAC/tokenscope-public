/*
 * Budget-alert worker — emits `over-budget` inbox items for projects whose
 * MTD attributed cost has exceeded their current baseline+top-up allocation,
 * and (#575) one `budget-nearly-used` item per project per month at 80%.
 *
 * It calls the SAME `completeProjectSpend` the project page, the /projects
 * cards and the budget editor call, with the same window and the same options,
 * so the inbox and those surfaces agree by construction
 * (server/usage/complete-spend.ts).
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
 * On otelPct / anthroPct: both are the REAL arm split of the figure that
 * tripped the alert, taken from the same `completeProjectSpend` row (arm 1
 * `otel-emitted` vs arm 2 `api-reconciled`).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox } from '../notifications/dispatch'
import { closeEndedPeriodAlerts } from '../notifications/period-close'
import { monthStartIso as monthStartIsoFor, monthToDateWindow } from '../utils/period'
import { completeProjectSpend } from '../usage/complete-spend'
import { fetchProjectAllocations } from '../usage/consumption'

export interface BudgetAlertResult {
  projectsScanned: number
  alertsDispatched: number
  skippedExisting: number
  /** #575: "Budget nearly used" items raised this run (projects at 80% or more, not over). */
  nearlyUsedDispatched: number
  nearlyUsedSkippedExisting: number
  /** #630: open alerts about a month or week that is over (plus 7 days' grace), closed this run. */
  periodEndedClosed: number
  /** #631: this month's budget alerts closed because the budget was raised and the project is inside it. */
  budgetRaisedClosed: number
}

/* #631: the reason stamped into a budget alert's body when a raised budget closes it. */
export const BUDGET_RAISED = 'budget-raised'

/*
 * #575: the share of the budget in force at which a project manager is told,
 * once a month, before the budget is gone. A fixed rule in code, not a dial
 * (REMAINING B6): the PO's call on the issue. Nothing is blocked at it.
 */
export const BUDGET_NEARLY_USED_AT = 0.8

interface ProjectRow extends Record<string, unknown> {
  project_id: string
  project_code: string
  display_name: string
}

export async function runBudgetAlert(
  db: PostgresJsDatabase<typeof schema>,
  opts?: { now?: Date },
): Promise<BudgetAlertResult> {
  const now = opts?.now ?? new Date()
  const monthStartIso = monthStartIsoFor(now)
  /*
   * #630: close alerts whose month or week is over FIRST, in the same tick and
   * before any dedupe below reads the inbox, so the checks this run makes see
   * the inbox as it will be left. The dedupes read the current month only, so
   * this changes no decision below; it keeps the order honest.
   */
  const periodEndedClosed = await closeEndedPeriodAlerts(db, now)
  /*
   * spendWindow — MONTH TO DATE `[monthStart, now)`. What has been spent. A row
   * dated later this month has not been spent yet, and counting it would page a
   * PM for an overage that has not happened (server/utils/period.ts).
   *
   * The cap is NOT a window question: it is the project's budget as the project
   * page shows it, read by the same reader at this run's `now` (below).
   */
  const spendWindow = monthToDateWindow(now)

  // Per-project MTD spend against the project's budget. Only projects with a
  // budget (cap > 0) are candidates; a project with none has no over-budget
  // concept.
  //
  // completeProjectSpend is THE project-spend definition (server/usage/
  // complete-spend.ts) — the SAME call the project page, the /projects cards
  // and the budget editor make, with the SAME window and the
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
   * here: `reconcileUnaccountedUsage` writes its upsert and both orphan
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

  // Cap = the project's budget exactly as the project page shows it: the pool
  // baseline and top-ups in force at this run's `now`, burst excluded, through
  // the page's own reader (fetchProjectAllocations), so a baseline starting
  // mid-month counts the same as a top-up. Only a project with spend can be over.
  //
  // #631: a project with an OPEN budget alert this month is read too, even when
  // its spend has fallen out of the map (a correction to zero), so a top-up
  // still closes its alert. Its spend counts as 0 below: it can raise nothing.
  const openAlertRows = await db.execute<{ project_id: string }>(sql`
    SELECT DISTINCT related_entity_id::text AS project_id FROM inbox_item
     WHERE category IN ('over-budget', 'budget-nearly-used')
       AND related_entity_kind = 'project'
       AND related_entity_id IS NOT NULL
       AND ack_state IN ('unread', 'read', 'acknowledged')
       AND created_at >= ${monthStartIso}::timestamptz
  `)
  const spentOn = [
    ...new Set([
      ...[...spendByProject.keys()].filter((id): id is string => !!id),
      ...[...openAlertRows].map((r) => r.project_id),
    ]),
  ]
  const capByProject = await fetchProjectAllocations(db, spentOn, now.toISOString())
  const capped = [...capByProject].filter(([, cap]) => cap > 0).map(([id]) => id)
  const rows =
    capped.length === 0
      ? []
      : await db.execute<ProjectRow>(sql`
          SELECT id::text AS project_id, code AS project_code, display_name
          FROM project
          WHERE id = ANY(ARRAY[${sql.join(
            capped.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}])
        `)

  let alertsDispatched = 0
  let skippedExisting = 0
  let nearlyUsedDispatched = 0
  let nearlyUsedSkippedExisting = 0
  let budgetRaisedClosed = 0
  const projectsScanned = rows.length

  for (const r of rows) {
    const usedUsd = spendByProject.get(r.project_id)?.costUsd ?? 0
    const capUsd = capByProject.get(r.project_id) ?? 0
    if (capUsd <= 0) continue
    budgetRaisedClosed += await closeOnRaisedBudget(db, r.project_id, usedUsd, capUsd, now, monthStartIso)
    if (usedUsd <= capUsd) {
      if (usedUsd >= capUsd * BUDGET_NEARLY_USED_AT) {
        const sent = await raiseNearlyUsed(db, r, usedUsd, capUsd, now, monthStartIso)
        if (sent === 'dispatched') nearlyUsedDispatched += 1
        else if (sent === 'existing') nearlyUsedSkippedExisting += 1
      }
      continue
    }

    // Idempotency: skip if ANY recipient has an over-budget item for this
    // project created since month-start AGAINST A BUDGET AT LEAST AS LARGE AS
    // TODAY'S (#631). A raised budget is a new question, so an overrun of it
    // tells the manager once; the same budget never re-pages. An item with no
    // `capUsd` (older bodies) counts as the same budget, so the first run after
    // this change re-alerts nothing. Tradeoff: per-recipient
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
           -- ANY item this month, regardless of ack_state, so a dismissed or
           -- resolved item still suppresses the next tick: one over-budget item
           -- per project per month and budget.
           AND created_at >= ${monthStartIso}::timestamptz
           AND ${raisedAgainstAtLeast(capUsd)}
         LIMIT 1
      `,
    )
    if (existing.length > 0) {
      skippedExisting += 1
      continue
    }

    const overBy = usedUsd - capUsd
    // "How we know" (DrawerBodyOverBudget): the REAL arm split of the figure
    // that tripped the alert. Arm 2 is the reconciled API−OTel gap, per project,
    // and it is exactly the share the PM most needs disclosed.
    const spend = spendByProject.get(r.project_id)
    // ONE denominator, guarded once. This branch only runs when usedUsd > capUsd,
    // and an allocation is non-negative, so usedUsd > 0 is already implied; the
    // floor stands between a nonsensical negative cap and a NaN percentage on a
    // PM's alert.
    const denom = usedUsd > 0 ? usedUsd : 1
    const otelPct = (spend?.otelUsd ?? 0) / denom
    const anthroPct = (spend?.reconciledUsd ?? 0) / denom

    const dispatched = await dispatchInbox(db, {
      category: 'over-budget',
      // #587: the product's words (budget) and money with thousands separators.
      // #630: and the month it is about, which the body carries too.
      subject: `${r.display_name} is $${Math.round(overBy).toLocaleString('en-US')} over its ${utcMonthName(now)} budget`,
      body: {
        project: r.project_code,
        month: monthStartIso.slice(0, 7),
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

  return {
    projectsScanned,
    alertsDispatched,
    skippedExisting,
    nearlyUsedDispatched,
    nearlyUsedSkippedExisting,
    periodEndedClosed,
    budgetRaisedClosed,
  }
}

/** The month's English name in UTC ("November"), as the 80% subject has always used. */
function utcMonthName(now: Date): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(now)
}

/*
 * #631: an item "raised against a budget at least as large as" `capUsd`. The
 * body's `capUsd` is the budget in force when it was raised; a body without a
 * numeric one (older items) counts as the same budget, so this change never
 * re-alerts the backlog.
 */
function raisedAgainstAtLeast(capUsd: number) {
  return sql`COALESCE(
    CASE WHEN jsonb_typeof(body->'capUsd') = 'number' THEN (body->>'capUsd')::numeric END,
    ${capUsd}::numeric
  ) >= ${capUsd}::numeric`
}

/*
 * #631: a top-up closes the alert that asked for it. An OPEN over-budget or
 * budget-nearly-used item of THIS month for the project is resolved when
 *   - the budget in force now is HIGHER than the budget it was raised against
 *     (its body's `capUsd`), and
 *   - the project is now under the threshold that raised it (not over the
 *     budget, or under 80% of it).
 * Both, so a spend correction alone (same budget, figure moved) never flaps an
 * item open and shut. Items of earlier months are #630's sweep, not this.
 */
async function closeOnRaisedBudget(
  db: PostgresJsDatabase<typeof schema>,
  projectId: string,
  usedUsd: number,
  capUsd: number,
  now: Date,
  monthStartIso: string,
): Promise<number> {
  if (usedUsd > capUsd) return 0
  const underNearly = usedUsd < capUsd * BUDGET_NEARLY_USED_AT
  const closed = await db.execute<{ id: string }>(sql`
    UPDATE inbox_item
       SET ack_state = 'resolved',
           ack_at = ${now.toISOString()}::timestamptz,
           -- The system closed it: no person is its actor.
           ack_by = NULL,
           body = body || jsonb_build_object(
             'closed_reason', ${BUDGET_RAISED}::text,
             'closed_cap_usd', ${capUsd}::numeric)
     WHERE related_entity_kind = 'project'
       AND related_entity_id = ${projectId}::uuid
       AND ack_state IN ('unread', 'read', 'acknowledged')
       AND created_at >= ${monthStartIso}::timestamptz
       AND jsonb_typeof(body->'capUsd') = 'number'
       AND (body->>'capUsd')::numeric < ${capUsd}::numeric
       AND (
         category = 'over-budget'
         OR (category = 'budget-nearly-used' AND ${underNearly}::boolean)
       )
    RETURNING id::text AS id
  `)
  return [...closed].length
}

/*
 * "Budget nearly used" (#575): once per project per month and budget (#631),
 * to the over-budget alert's recipients, when month-to-date spend is at 80% or
 * more of the budget in force and not over it. Never after an over-budget
 * alert against the same or a larger budget: a project that passed 100% this
 * month (in any state) gets no 80% item until the budget is raised past the
 * one it overran, and a project that jumps from under 80% to over 100% between
 * runs gets the over-budget one only (the caller takes the over branch first).
 *
 * The body is a snapshot of the run that raised it: the drawer draws the pace
 * line from `dayOfMonth` / `daysInMonth` with the same `projectedMonthEnd` My
 * projects uses (app/composables/useRagState.ts), so it says what the pace was
 * when the alert was raised, as of the UTC day the server counted.
 */
async function raiseNearlyUsed(
  db: PostgresJsDatabase<typeof schema>,
  r: ProjectRow,
  usedUsd: number,
  capUsd: number,
  now: Date,
  monthStartIso: string,
): Promise<'dispatched' | 'existing' | 'none'> {
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM inbox_item
     WHERE category IN ('budget-nearly-used', 'over-budget')
       AND related_entity_kind = 'project'
       AND related_entity_id = ${r.project_id}::uuid
       AND created_at >= ${monthStartIso}::timestamptz
       -- #631: only an item raised against a budget at least as large as
       -- today's suppresses; a raised budget gets its own 80% item, once.
       AND ${raisedAgainstAtLeast(capUsd)}
     LIMIT 1
  `)
  if (existing.length > 0) return 'existing'

  const usedPct = usedUsd / capUsd
  const dayOfMonth = now.getUTCDate()
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  const monthName = utcMonthName(now)
  // Floor, not round: 79.6% must not read "80%", and 99.7% must not read "100%".
  const shownPct = Math.floor(usedPct * 100)

  const dispatched = await dispatchInbox(db, {
    category: 'budget-nearly-used',
    subject: `${r.display_name} has used ${shownPct}% of its ${monthName} budget`,
    body: {
      project: r.project_code,
      projectName: r.display_name,
      usedUsd,
      capUsd,
      usedPct,
      thresholdPct: BUDGET_NEARLY_USED_AT,
      month: monthStartIso.slice(0, 7),
      dayOfMonth,
      daysInMonth,
    },
    relatedEntityKind: 'project',
    relatedEntityId: r.project_id,
    now,
  })
  return dispatched.length > 0 ? 'dispatched' : 'none'
}
