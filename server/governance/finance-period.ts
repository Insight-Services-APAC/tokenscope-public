/*
 * finance-period — audited close / reopen / restate for `finance_period`
 * (Required outcome 1, design §4.1 / §8.4).
 *
 * SEMANTICS.
 *   open   — the default (absence of a finance_period row for a month IS open;
 *            no need to pre-create a row for every future month). Verdicts
 *            recompute from current governance on every recompute call that
 *            reaches them (worker tick, a scoped billing-edit recompute, or an
 *            explicit close/restate's own convergence pass).
 *   closed — verdicts FROZEN. `recomputeGovernanceVerdicts` structurally
 *            excludes closed-period rows (the join in recompute.ts), so a
 *            later `billing` edit cannot touch them by ANY path except the
 *            two audited actions below.
 *
 *   reopen   — closed -> open. Makes the period ordinarily-recomputable again
 *              (by the next worker tick or a scoped billing edit) — for an
 *              extended correction window. Clears the per-row
 *              governance_verdict_locked_at back to NULL (they are no longer
 *              frozen) but does NOT itself recompute — the caller decides when.
 *   restate  — closed -> (recompute to convergence against CURRENT governance)
 *              -> closed again, atomically, in ONE call. For a single
 *              known correction (e.g. a late bill anchor, design §8.4) where
 *              leaving the whole period open to arbitrary future drift is not
 *              wanted — the audited, single-shot alternative to reopen.
 *
 * SERIALISATION (design §8.4): every mutating call here takes the
 * `financePeriod` advisory lock keyed on `periodMonth` FIRST, then
 * `SELECT ... FOR UPDATE` (or upserts) the `finance_period` row itself — belt
 * + braces, because the advisory lock also covers the "no row exists yet"
 * case that a row-level lock cannot. A concurrent
 * `recomputeGovernanceVerdicts` call scoped to the SAME period (e.g. a
 * billing-edit's inline recompute) takes the SAME lock before touching any
 * `actual_spend` row in that period (see server/api/v1/admin/reconciliation/
 * {orgs,enterprises}/[id].patch.ts), so a close can never observe — or be
 * observed mid-way through — a partial recompute.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { advisoryXactLock } from '../db/advisory-lock'
import { recordAuditEvent } from '../db/audit'
import { recomputeGovernanceVerdicts } from './recompute'

type Db = PostgresJsDatabase<typeof schema>
type Tx = PostgresJsDatabase<Record<string, unknown>>

/** Safety cap on the close/restate convergence loop — a period's row count is
 *  bounded (one calendar month of actual_spend), so this is generous headroom,
 *  not a normal-case limit. Failing loud beats freezing a partially-stale
 *  snapshot silently. */
const MAX_CONVERGENCE_BATCHES = 50

export type FinancePeriodState = 'open' | 'closed'

export interface FinancePeriodRow {
  periodMonth: string
  state: FinancePeriodState
  closedAt: string | null
  closedBy: string | null
  reopenedAt: string | null
  reopenedBy: string | null
  reopenReason: string | null
  restatedAt: string | null
  restatedBy: string | null
  restateReason: string | null
}

function normalisePeriodMonth(periodMonth: string): string {
  // Accept 'YYYY-MM' or 'YYYY-MM-01'; always store/compare the first-of-month.
  const m = /^(\d{4})-(\d{2})(?:-01)?$/.exec(periodMonth)
  if (!m) throw new Error(`finance-period: periodMonth must be YYYY-MM or YYYY-MM-01, got '${periodMonth}'`)
  return `${m[1]}-${m[2]}-01`
}

async function lockPeriod(tx: Tx, periodMonth: string): Promise<void> {
  await tx.execute(advisoryXactLock('financePeriod', periodMonth))
}

/** Close/restate are irreversible cutover-boundary events. Take this after the
 * finance-period lock (namespace 4 -> 5) so rollback cannot pass its
 * closed-since-activation check while either event commits concurrently. */
async function lockGovernanceCutover(tx: Tx): Promise<void> {
  await tx.execute(advisoryXactLock('governanceCutover', 'state'))
}

/** Read the CURRENT row (or the implicit-open default when absent). Row-locking
 *  variant used inside a mutating transaction; callers that only need to READ
 *  (e.g. the admin list endpoint) should use `getFinancePeriod` instead. */
async function lockAndReadPeriodRow(tx: Tx, periodMonth: string): Promise<FinancePeriodRow | null> {
  const rows = await tx.execute<{
    period_month: string
    state: FinancePeriodState
    closed_at: string | null
    closed_by: string | null
    reopened_at: string | null
    reopened_by: string | null
    reopen_reason: string | null
    restated_at: string | null
    restated_by: string | null
    restate_reason: string | null
  }>(sql`
    SELECT period_month::text AS period_month, state, closed_at::text AS closed_at, closed_by::text AS closed_by,
           reopened_at::text AS reopened_at, reopened_by::text AS reopened_by, reopen_reason,
           restated_at::text AS restated_at, restated_by::text AS restated_by, restate_reason
    FROM finance_period WHERE period_month = ${periodMonth}::date
    FOR UPDATE
  `)
  const r = rows[0]
  if (!r) return null
  return {
    periodMonth: r.period_month,
    state: r.state,
    closedAt: r.closed_at,
    closedBy: r.closed_by,
    reopenedAt: r.reopened_at,
    reopenedBy: r.reopened_by,
    reopenReason: r.reopen_reason,
    restatedAt: r.restated_at,
    restatedBy: r.restated_by,
    restateReason: r.restate_reason,
  }
}

/** Public read (no lock — for listing/status surfaces). Absence => implicit open. */
export async function getFinancePeriod(
  db: Pick<Db, 'execute'>,
  periodMonth: string,
): Promise<FinancePeriodRow> {
  const pm = normalisePeriodMonth(periodMonth)
  const rows = await db.execute<{
    period_month: string
    state: FinancePeriodState
    closed_at: string | null
    closed_by: string | null
    reopened_at: string | null
    reopened_by: string | null
    reopen_reason: string | null
    restated_at: string | null
    restated_by: string | null
    restate_reason: string | null
  }>(sql`
    SELECT period_month::text AS period_month, state, closed_at::text AS closed_at, closed_by::text AS closed_by,
           reopened_at::text AS reopened_at, reopened_by::text AS reopened_by, reopen_reason,
           restated_at::text AS restated_at, restated_by::text AS restated_by, restate_reason
    FROM finance_period WHERE period_month = ${pm}::date
  `)
  const r = rows[0]
  if (!r) {
    return {
      periodMonth: pm,
      state: 'open',
      closedAt: null,
      closedBy: null,
      reopenedAt: null,
      reopenedBy: null,
      reopenReason: null,
      restatedAt: null,
      restatedBy: null,
      restateReason: null,
    }
  }
  return {
    periodMonth: r.period_month,
    state: r.state,
    closedAt: r.closed_at,
    closedBy: r.closed_by,
    reopenedAt: r.reopened_at,
    reopenedBy: r.reopened_by,
    reopenReason: r.reopen_reason,
    restatedAt: r.restated_at,
    restatedBy: r.restated_by,
    restateReason: r.restate_reason,
  }
}

/** Loop recompute to convergence for one period, inside the caller's transaction. */
async function convergeRecompute(tx: Tx, periodMonth: string): Promise<number> {
  let totalUpdated = 0
  for (let i = 0; i < MAX_CONVERGENCE_BATCHES; i++) {
    const r = await recomputeGovernanceVerdicts(tx, { periodMonth })
    totalUpdated += r.updated
    if (!r.hasMore) return totalUpdated
  }
  throw new Error(
    `finance-period: recompute for ${periodMonth} did not converge within ${MAX_CONVERGENCE_BATCHES} batches — aborting close/restate rather than freezing a partial snapshot`,
  )
}

export class FinancePeriodError extends Error {
  constructor(
    message: string,
    public readonly code: 'already-closed' | 'not-closed' | 'already-open',
  ) {
    super(message)
    this.name = 'FinancePeriodError'
  }
}

export interface CloseFinancePeriodResult {
  period: FinancePeriodRow
  rowsRecomputed: number
  rowsLocked: number
}

/** Close a period: converge recompute against CURRENT governance, stamp every
 *  row's governance_verdict_locked_at, then mark the period closed. Audited. */
export async function closeFinancePeriod(
  tx: Tx,
  args: { periodMonth: string; actorTeammateId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<CloseFinancePeriodResult> {
  const pm = normalisePeriodMonth(args.periodMonth)
  await lockPeriod(tx, pm)
  await lockGovernanceCutover(tx)
  const existing = await lockAndReadPeriodRow(tx, pm)
  if (existing && existing.state === 'closed') {
    throw new FinancePeriodError(`finance period ${pm} is already closed`, 'already-closed')
  }

  const rowsRecomputed = await convergeRecompute(tx, pm)

  const lockedRows = await tx.execute<{ id: string }>(sql`
    UPDATE actual_spend
    SET governance_verdict_locked_at = now()
    WHERE date_trunc('month', date)::date = ${pm}::date
      AND governance_verdict_locked_at IS NULL
    RETURNING id
  `)

  await tx.execute(sql`
    INSERT INTO finance_period (period_month, state, closed_at, closed_by)
    VALUES (${pm}::date, 'closed', now(), ${args.actorTeammateId}::uuid)
    ON CONFLICT (period_month) DO UPDATE SET
      state = 'closed', closed_at = now(), closed_by = ${args.actorTeammateId}::uuid
  `)

  await recordAuditEvent(tx, {
    eventType: 'finance-period-closed',
    actorTeammateId: args.actorTeammateId,
    subjectKind: 'finance_period',
    subjectId: null,
    payload: { periodMonth: pm, rowsRecomputed, rowsLocked: lockedRows.length },
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  })

  const period = await getFinancePeriod(tx, pm)
  return { period, rowsRecomputed, rowsLocked: lockedRows.length }
}

export interface ReopenFinancePeriodResult {
  period: FinancePeriodRow
  rowsUnlocked: number
}

/** Reopen a closed period: clears the freeze (per-row locked_at + state), does
 *  NOT itself recompute — the period simply becomes ordinarily-recomputable
 *  again. Audited, with a mandatory reason (a reopen is always a deliberate,
 *  explainable decision — never a silent side-effect). */
export async function reopenFinancePeriod(
  tx: Tx,
  args: { periodMonth: string; actorTeammateId: string; reason: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<ReopenFinancePeriodResult> {
  const pm = normalisePeriodMonth(args.periodMonth)
  await lockPeriod(tx, pm)
  const existing = await lockAndReadPeriodRow(tx, pm)
  if (!existing || existing.state !== 'closed') {
    throw new FinancePeriodError(`finance period ${pm} is not closed`, 'not-closed')
  }

  const unlockedRows = await tx.execute<{ id: string }>(sql`
    UPDATE actual_spend
    SET governance_verdict_locked_at = NULL
    WHERE date_trunc('month', date)::date = ${pm}::date
      AND governance_verdict_locked_at IS NOT NULL
    RETURNING id
  `)

  await tx.execute(sql`
    UPDATE finance_period
    SET state = 'open', reopened_at = now(), reopened_by = ${args.actorTeammateId}::uuid, reopen_reason = ${args.reason}
    WHERE period_month = ${pm}::date
  `)

  await recordAuditEvent(tx, {
    eventType: 'finance-period-reopened',
    actorTeammateId: args.actorTeammateId,
    subjectKind: 'finance_period',
    subjectId: null,
    payload: { periodMonth: pm, reason: args.reason, rowsUnlocked: unlockedRows.length },
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  })

  const period = await getFinancePeriod(tx, pm)
  return { period, rowsUnlocked: unlockedRows.length }
}

export interface RestateFinancePeriodResult {
  period: FinancePeriodRow
  rowsRecomputed: number
}

/** Restate a closed period IN PLACE: recompute to convergence against CURRENT
 *  governance, then re-freeze — without leaving the period open to arbitrary
 *  future drift. The audited single-shot correction path (design §8.4 "a late
 *  bill anchor for a closed month requires the audited reopen/restate path"). */
export async function restateFinancePeriod(
  tx: Tx,
  args: { periodMonth: string; actorTeammateId: string; reason: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<RestateFinancePeriodResult> {
  const pm = normalisePeriodMonth(args.periodMonth)
  await lockPeriod(tx, pm)
  await lockGovernanceCutover(tx)
  const existing = await lockAndReadPeriodRow(tx, pm)
  if (!existing || existing.state !== 'closed') {
    throw new FinancePeriodError(`finance period ${pm} is not closed (restate only applies to a closed period)`, 'not-closed')
  }

  // Transiently reopen (within this SAME transaction — invisible to any other
  // caller, which is blocked on the advisory lock we already hold) so
  // recompute's "open period" scope actually includes this period's rows, and
  // unlock the rows themselves so recompute may change them, then re-close +
  // re-lock at the new watermark. recomputeGovernanceVerdicts filters on
  // finance_period.state, NOT on the row-level lock alone — both must flip.
  await tx.execute(sql`UPDATE finance_period SET state = 'open' WHERE period_month = ${pm}::date`)
  await tx.execute(sql`
    UPDATE actual_spend SET governance_verdict_locked_at = NULL
    WHERE date_trunc('month', date)::date = ${pm}::date
  `)
  const rowsRecomputed = await convergeRecompute(tx, pm)
  await tx.execute(sql`
    UPDATE actual_spend SET governance_verdict_locked_at = now()
    WHERE date_trunc('month', date)::date = ${pm}::date AND governance_verdict_locked_at IS NULL
  `)

  await tx.execute(sql`
    UPDATE finance_period
    SET state = 'closed', restated_at = now(), restated_by = ${args.actorTeammateId}::uuid, restate_reason = ${args.reason}
    WHERE period_month = ${pm}::date
  `)

  await recordAuditEvent(tx, {
    eventType: 'finance-period-restated',
    actorTeammateId: args.actorTeammateId,
    subjectKind: 'finance_period',
    subjectId: null,
    payload: { periodMonth: pm, reason: args.reason, rowsRecomputed },
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  })

  const period = await getFinancePeriod(tx, pm)
  return { period, rowsRecomputed }
}
