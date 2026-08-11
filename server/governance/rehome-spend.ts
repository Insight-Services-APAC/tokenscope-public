/*
 * rehome-spend — restate the Business Unit stamped on historic §A usage for a
 * PROJECT, on a manual admin correction.
 *
 * ── WHY IT LIVES IN governance/ AND NOT reporting/ ───────────────────────────
 * It was written into `server/reporting/` and the lane firewall
 * (`tests/unit/server/reports-lane-firewall.test.ts`) rejected it, correctly:
 * that directory is the reporting READ path, where the usage lane may only
 * touch `v_complete_usage`. This module WRITES `attribution_record`. It is a
 * restatement of recorded spend, which is what `finance-period.ts` next door
 * already does for a period — so it belongs with the other operations that
 * rewrite settled facts, not with the queries that read them.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * `attribution_record.cost_owning_unit_id` is stamped when the row is written,
 * from the project's BU at that moment, and never refreshed (`Data-Lineage.md`
 * §Org placement). The freeze is deliberate for a REORG — moving a team next
 * March must not rewrite last month's bill (owner decision 2026-08-02).
 *
 * It was also being applied to CORRECTIONS. On 2026-08-10 a BU owner homed
 * their four projects to the BU they own; the page kept reading $0.00 and
 * annotated each project "$0.00 from this cost centre" beside its real total.
 * The admin made the right change, in an open month, and it was discarded.
 *
 * ── THE RULE (owner, 2026-08-10) ─────────────────────────────────────────────
 * WHO moved it decides whether history moves. Graph/API placement never
 * re-homes (a reorg). An admin-site MANUAL move offers it (a correction). This
 * module must therefore never be reachable from `placement-service.ts`.
 *
 * ── SCOPE: PROJECTS ONLY, DELIBERATELY ───────────────────────────────────────
 * A teammate move cannot use this. Attribution's `cost_owning_unit_id` is the
 * PROJECT's BU; teammate placement lives in `region_id`/`org_unit_id`, which
 * this never touches. An earlier draft of the spec promised the user-placement
 * endpoint would call this — it could not have. The people axis is fixed by
 * OD1 person-placed homing, which reads live placement and needs no mutation.
 *
 * ── WHAT THE 2026-08-10 EXTERNAL REVIEW CHANGED ──────────────────────────────
 * (`docs/design/reviews/2026-08-10-sol-bu-correction-slice.md`; its
 * finance-close and already-reported findings assumed finance users, of which
 * there are none yet. These four were mechanical and are fixed here.)
 *
 *   · `ts_recorded` IS BUMPED. The rollup worker detects retroactive mutation
 *     by exactly that column (`aggregate-rollup.ts` incremental window). Moving
 *     the BU without it leaves the aggregates silently disagreeing with the
 *     ledger they are derived from — the failure this whole page is about.
 *   · ARCHIVED DAYS ARE REFUSED AND NAMED, not silently skipped. Below the
 *     freeze floor the raw rows are gone and only `spend_rollup_daily` holds
 *     the history, so a re-home there would report success over cold cells
 *     still carrying the old BU.
 *   · ONLY `spend_rollup_daily` needs recomputing — it is the one derived table
 *     carrying the BU dimension. `spend_session_daily` has no such column and
 *     `unaccounted_usage` is not project-scoped.
 *   · THE PLAN IS A TOKEN. Preview and apply are separate requests; a shared
 *     predicate does not make them a shared row set. Apply re-derives the plan
 *     and refuses if it no longer matches what was shown.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { createHash } from 'node:crypto'
import { advisoryXactLock } from '../db/advisory-lock'
import type * as schema from '../../drizzle/schema'

type Tx = PostgresJsDatabase<typeof schema>

/**
 * How far back to restate.
 *
 * `'all'` is NOT a synonym for "every month": a missing `finance_period` row
 * means OPEN by design, so an unbounded range would reach every month nobody
 * ever closed. It therefore requires `confirmUnbounded` at the call site, and
 * the plan still enumerates exactly which periods it would touch.
 */
export type RehomeRange = { from: string } | { from: 'all'; confirmUnbounded: true }

export interface RehomePeriodEffect {
  /** 'YYYY-MM-01'. */
  periodMonth: string
  rows: number
  usd: number
}

/** Why a period in range is untouchable. Both are REPORTED, never silent. */
export type RehomeRefusal = 'closed-period' | 'archived'

export interface RehomeRefusedPeriod extends RehomePeriodEffect {
  reason: RehomeRefusal
}

export interface RehomePlan {
  projectId: string
  toCostOwningUnitId: string
  /**
   * Every BU the affected rows are moving AWAY from, with what each carries.
   *
   * NOT the project's current `cost_owning_unit_id`. A project's history can be
   * stamped with several BUs — it was homed differently in the past, or spend
   * predates a homing — so auditing a migrate as "B → C" using the project's
   * present value loses the fact that A moved too, and a finance reconstruction
   * would be looking for money in the wrong place.
   */
  fromCostOwningUnits: { costOwningUnitId: string | null; rows: number; usd: number }[]
  /** Periods this WOULD change. */
  affected: RehomePeriodEffect[]
  /** In range, and deliberately left alone — with the reason. */
  refused: RehomeRefusedPeriod[]
  totalRows: number
  totalUsd: number
  /**
   * Binds a preview to the row set it described. `applyRehome` re-plans and
   * compares: if ingest, another move, or a close has changed the picture, the
   * admin is shown the new plan instead of silently writing a different one.
   */
  token: string
}

function planToken(p: Omit<RehomePlan, 'token'>): string {
  const shape = JSON.stringify([
    p.projectId,
    p.toCostOwningUnitId,
    p.affected.map((e) => [e.periodMonth, e.rows, e.usd.toFixed(4)]),
    p.fromCostOwningUnits.map((e) => [e.costOwningUnitId, e.rows]),
    p.refused.map((e) => [e.periodMonth, e.reason, e.rows]),
  ])
  return createHash('sha256').update(shape).digest('hex').slice(0, 32)
}

/**
 * The freeze floor, as a date — days at or below it are archived and their raw
 * attribution may be gone. Shares the worker's own env override so the two
 * cannot disagree about where cold starts.
 */
function freezeFloorSql() {
  const days = process.env.LEDGER_ROLLUP_FREEZE_FLOOR_DAYS
    ? Number(process.env.LEDGER_ROLLUP_FREEZE_FLOOR_DAYS)
    : null
  return days != null && Number.isFinite(days)
    ? sql`((now() AT TIME ZONE 'UTC')::date - ${days}::int)`
    : null
}

/** The row set, as ONE expression — shared by plan and apply. */
function scopePredicate(projectId: string, range: RehomeRange, toCouId: string) {
  const fromClause = range.from === 'all' ? sql`TRUE` : sql`ar.ts_event >= ${range.from}::date`
  return sql`
    ar.project_id = ${projectId}::uuid
    AND ${fromClause}
    -- Rows already homed where they are going are not a change; counting them
    -- would make a no-op preview look like a restatement.
    AND ar.cost_owning_unit_id IS DISTINCT FROM ${toCouId}::uuid`
}

/** What WOULD move, and what will not. Read-only. */
export async function planRehome(
  tx: Tx,
  opts: { projectId: string; toCostOwningUnitId: string; range: RehomeRange },
): Promise<RehomePlan> {
  const floor = freezeFloorSql()
  const archivedExpr = floor ? sql`(ar.ts_event AT TIME ZONE 'UTC')::date <= ${floor}` : sql`FALSE`

  const rows = [
    ...(await tx.execute<{
      period_month: string
      closed: boolean
      archived: boolean
      from_cou: string | null
      rows: string
      usd: string
    }>(sql`
      SELECT date_trunc('month', ar.ts_event AT TIME ZONE 'UTC')::date::text AS period_month,
             COALESCE(fp.state, 'open') = 'closed'                           AS closed,
             ${archivedExpr}                                                 AS archived,
             ar.cost_owning_unit_id::text                                    AS from_cou,
             COUNT(*)::text                                                  AS rows,
             COALESCE(SUM(ar.cost_usd), 0)::text                             AS usd
        FROM attribution_record ar
        LEFT JOIN finance_period fp
               ON fp.period_month = date_trunc('month', ar.ts_event AT TIME ZONE 'UTC')::date
       WHERE ${scopePredicate(opts.projectId, opts.range, opts.toCostOwningUnitId)}
       GROUP BY 1, 2, 3, 4
       ORDER BY 1`)),
  ]

  /*
   * The query groups by (period, closed, archived, source BU), so a period can
   * appear on several rows. Fold back to one entry per period for the operator,
   * and separately accumulate the source BUs for the audit.
   */
  const byPeriod = new Map<string, RehomePeriodEffect>()
  const refusedByKey = new Map<string, RehomeRefusedPeriod>()
  const bySource = new Map<string, { costOwningUnitId: string | null; rows: number; usd: number }>()
  for (const r of rows) {
    const rowCount = Number(r.rows)
    const usd = Number(r.usd)
    // Closed outranks archived in the message: it is the deliberate policy, and
    // the operator's next action differs (reopen vs "there is nothing to move").
    const reason: RehomeRefusal | null = r.closed ? 'closed-period' : r.archived ? 'archived' : null
    if (reason) {
      const k = `${r.period_month}:${reason}`
      const prev = refusedByKey.get(k)
      refusedByKey.set(k, {
        periodMonth: r.period_month,
        reason,
        rows: (prev?.rows ?? 0) + rowCount,
        usd: (prev?.usd ?? 0) + usd,
      })
      continue
    }
    const prev = byPeriod.get(r.period_month)
    byPeriod.set(r.period_month, {
      periodMonth: r.period_month,
      rows: (prev?.rows ?? 0) + rowCount,
      usd: (prev?.usd ?? 0) + usd,
    })
    const sk = r.from_cou ?? '__null__'
    const ps = bySource.get(sk)
    bySource.set(sk, {
      costOwningUnitId: r.from_cou,
      rows: (ps?.rows ?? 0) + rowCount,
      usd: (ps?.usd ?? 0) + usd,
    })
  }
  const affected = [...byPeriod.values()].sort((a, b) => a.periodMonth.localeCompare(b.periodMonth))
  const refused = [...refusedByKey.values()].sort((a, b) => a.periodMonth.localeCompare(b.periodMonth))

  const base = {
    projectId: opts.projectId,
    toCostOwningUnitId: opts.toCostOwningUnitId,
    fromCostOwningUnits: [...bySource.values()].sort((a, b) => b.usd - a.usd),
    affected,
    refused,
    totalRows: affected.reduce((a, e) => a + e.rows, 0),
    totalUsd: affected.reduce((a, e) => a + e.usd, 0),
  }
  return { ...base, token: planToken(base) }
}

export class RehomePlanStale extends Error {
  constructor(readonly current: RehomePlan) {
    super('rehome: the data changed since the preview — re-check the plan before applying')
    this.name = 'RehomePlanStale'
  }
}

export interface RehomeResult extends RehomePlan {
  updated: number
  /** Dollars ACTUALLY moved — from the returned rows, never from the plan. */
  appliedUsd: number
  /** Event-days touched — what `spend_rollup_daily` must be recomputed for. */
  affectedDays: string[]
}

/**
 * Apply the restatement. MUST run inside the caller's transaction, alongside
 * the project's own BU change: a re-home that commits without its move (or the
 * reverse) leaves the ledger disagreeing with the org.
 *
 * Takes the `financePeriod` advisory lock for every period it will touch.
 * That namespace exists for precisely this shape — its own comment notes the
 * lock "serialises even the 'period row does not exist yet' case, which a
 * row-level lock cannot cover", which is the case here, since an unclosed month
 * has no row at all.
 */
export async function applyRehome(
  tx: Tx,
  opts: { projectId: string; toCostOwningUnitId: string; range: RehomeRange; expectToken?: string },
): Promise<RehomeResult> {
  /*
   * PLAN, LOCK, RE-PLAN — in that order, and the order is the correctness.
   *
   * The first plan exists only to learn WHICH periods to lock. Validating the
   * token against it and then writing would leave a window in which a period
   * closes while this transaction waits on its lock: the UPDATE correctly skips
   * that month, but the response and the audit still report it under
   * `affected`, claiming money moved that did not. The plan the caller is held
   * to must be the one taken WITH the locks held.
   *
   * Locks in a TOTAL ORDER (the plan is sorted by period), so two concurrent
   * migrates over overlapping months cannot deadlock by taking the same pair in
   * opposite orders.
   */
  const scouted = await planRehome(tx, opts)
  for (const p of scouted.affected) await tx.execute(advisoryXactLock('financePeriod', p.periodMonth))

  const plan = await planRehome(tx, opts)
  if (opts.expectToken !== undefined && opts.expectToken !== plan.token) throw new RehomePlanStale(plan)
  if (plan.affected.length === 0) return { ...plan, updated: 0, appliedUsd: 0, affectedDays: [] }

  const floor = freezeFloorSql()
  const notArchived = floor ? sql`AND (ar.ts_event AT TIME ZONE 'UTC')::date > ${floor}` : sql``

  /*
   * THE WRITE IS BOUNDED BY THE PLANNED PERIODS, not just by the predicate.
   *
   * Without this the UPDATE re-ran an open-ended range and could sweep in rows
   * that arrived AFTER planning — including rows in a month the loop above
   * never locked, and never showed the admin. Restricting to the periods we
   * planned and hold locks for makes the write exactly the set that was
   * previewed, and makes "previewed == applied" a property of the SQL rather
   * than a race we happen to win.
   *
   * Rows that land in a planned month between plan and write are still caught
   * (same month, same lock) and are the reason `updated` is reported separately
   * from the plan's own totals.
   */
  const plannedMonths = sql.join(
    plan.affected.map((p) => sql`${p.periodMonth}::date`),
    sql`, `,
  )

  const updated = [
    ...(await tx.execute<{ day: string; usd: string }>(sql`
      UPDATE attribution_record ar
         SET cost_owning_unit_id = ${opts.toCostOwningUnitId}::uuid,
             -- SO THE ROLLUP NOTICES. The incremental window keys on
             -- ts_recorded; without this the aggregates keep the old BU and
             -- disagree with the ledger they summarise.
             ts_recorded = now()
       WHERE ${scopePredicate(opts.projectId, opts.range, opts.toCostOwningUnitId)}
         AND date_trunc('month', ar.ts_event AT TIME ZONE 'UTC')::date IN (${plannedMonths})
         ${notArchived}
         -- Re-checked in the WRITE, not trusted from the plan: two statements,
         -- and a period can close between them.
         AND NOT EXISTS (
           SELECT 1 FROM finance_period fp
            WHERE fp.period_month = date_trunc('month', ar.ts_event AT TIME ZONE 'UTC')::date
              AND fp.state = 'closed')
      RETURNING (ar.ts_event AT TIME ZONE 'UTC')::date::text AS day,
                ar.cost_usd::text AS usd`)),
  ]

  /*
   * `applied` is measured from the ROWS THAT MOVED, not from the plan. A period
   * can close while this transaction waits for its lock: the UPDATE then
   * correctly skips it, and reporting the plan's dollars would have the response
   * and the audit both claim money moved that did not.
   */
  const appliedUsd = updated.reduce((a, r) => a + Number(r.usd), 0)

  return {
    ...plan,
    updated: updated.length,
    appliedUsd,
    affectedDays: [...new Set(updated.map((r) => r.day))].sort(),
  }
}
