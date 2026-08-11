/*
 * reporting-snapshot — recording what a month looked like when it was closed.
 *
 * ── WHAT THIS REPLACED, AND WHY ──────────────────────────────────────────────
 * `finance-period.ts` implemented close / reopen / restate over a `state`
 * column, and `closed` meant FROZEN: `recomputeGovernanceVerdicts` structurally
 * excluded closed rows, a database trigger refused `actual_spend` writes, and
 * the Copilot re-pull returned 409.
 *
 * The timeline that ended it (owner, 2026-08-10): we close at +2 after month
 * end, Copilot corrects its billing rows at +6, the bill lands at +10 — and the
 * product rejected the authoritative source because of a state we set
 * ourselves. TokenScope is not the billing system of record. The bill is right;
 * we are not. Refusing it never protected the month, it guaranteed the month
 * stayed wrong until somebody performed a reopen → re-pull → re-close ceremony.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * The bill always lands. Closing RECORDS what we reported; it blocks nothing.
 * Ingestion, re-polls and governance recompute all proceed on a closed month
 * exactly as on an open one, and a month that subsequently moves reports its
 * DELTA against what was recorded.
 *
 * A wall hands finance a number they know is wrong and no way in. A diff hands
 * them the correction and its cause.
 *
 * ── WHAT IS GONE, AND WHY NOTHING REPLACES IT ────────────────────────────────
 * `reopen` and `restate` existed only to get back INTO a state the lock had
 * shut. With nothing locked there is nothing to unlock: a correction is just a
 * write, and the delta is how anyone learns it happened. `state` went with
 * them — a row's EXISTENCE is the close.
 *
 * Note for anyone reading `Reporting.md`, which describes `restate` as the
 * audited path "for a known correction (e.g. a late bill anchor)": the original
 * design SAW the late bill and chose block-then-restate. This reverses that
 * trade deliberately. It is a decision, not a correction of an oversight.
 *
 * ── SERIALISATION ────────────────────────────────────────────────────────────
 * Taking a snapshot holds the `reportingSnapshot` advisory lock (ordinal 4,
 * unchanged across the rename so the lock space survives a rolling deploy) and
 * `SELECT ... FOR UPDATE`s the row — belt and braces, because the advisory lock
 * also covers the "no row exists yet" case a row lock cannot. It serialises a
 * snapshot against a concurrent recompute of the same month, so a snapshot can
 * never record a half-recomputed set of verdicts. It does NOT serialise against
 * ingestion, deliberately: ingestion is never blocked.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { advisoryXactLock } from '../db/advisory-lock'
import { recordAuditEvent } from '../db/audit'
import type * as schema from '../../drizzle/schema'

type Tx = PostgresJsDatabase<typeof schema>

/** The attribution basis a snapshot was taken under. */
export type ReportingBasis = 'person-placed' | 'project-homed'

/**
 * Bumped when WHAT is snapshotted changes shape. A delta across versions
 * refuses to subtract rather than comparing unlike things.
 */
export const SNAPSHOT_VERSION = 2

/**
 * WHAT A MONTH READS — the one query, used to record the snapshot AND to take
 * the delta against it.
 *
 * ONE FUNCTION ON PURPOSE. These were two copies of the same SQL, which is the
 * only way a delta can drift from the thing it is measuring: change how a month
 * is read in one place and every month starts reporting a movement that never
 * happened.
 *
 * ── THE LANES ────────────────────────────────────────────────────────────────
 * `attributed` is §A — `v_complete_usage`, everything, chargeable or not.
 *
 * `chargeable` is §B and reads `v_finance_chargeback_month`, the canonical
 * chargeback lane (Anthropic per-teammate month-rolled ∪ Copilot per-org pooled
 * net). It used to read `actual_spend` directly, which is the ANTHROPIC lane
 * alone: a month whose only bill was a pooled Copilot invoice snapshotted as
 * $0.00 chargeable, and a later Copilot correction produced no delta — the
 * exact failure the snapshot exists to catch. `copilot-unclassified` is
 * excluded because it is counted and alerted but NEVER charged.
 *
 * `exempt` stays on `actual_spend`: exemption is a per-row Anthropic verdict
 * (`chargeback_exempt`) and the pooled lanes have no equivalent, so this is the
 * whole of it rather than a partial read of something wider.
 */
function monthTotalsSql(periodMonth: string) {
  return sql`
    SELECT
      COALESCE((SELECT SUM(u.cost_usd) FROM v_complete_usage u
                 WHERE u.ts_event >= ${periodMonth}::date
                   AND u.ts_event <  (${periodMonth}::date + interval '1 month')), 0)::text AS attributed,
      COALESCE((SELECT SUM(c.charge_usd) FROM v_finance_chargeback_month c
                 WHERE c.period_month = ${periodMonth}::date
                   AND c.tool <> 'copilot-unclassified'), 0)::text AS chargeable,
      COALESCE((SELECT SUM(a.cost_usd) FROM actual_spend a
                 WHERE a.date >= ${periodMonth}::date
                   AND a.date < (${periodMonth}::date + interval '1 month')
                   AND a.chargeback_exempt), 0)::text AS exempt`
}

export interface ReportingSnapshotRow {
  periodMonth: string
  closedAt: string
  closedBy: string | null
  basis: ReportingBasis
  snapshotVersion: number
  attributedUsd: number
  chargeableUsd: number
  exemptUsd: number
}

export class ReportingSnapshotError extends Error {
  constructor(
    message: string,
    readonly code: 'already-closed',
  ) {
    super(message)
    this.name = 'ReportingSnapshotError'
  }
}

/** `YYYY-MM` or `YYYY-MM-01` → `YYYY-MM-01`. */
function normalisePeriodMonth(periodMonth: string): string {
  const m = /^(\d{4})-(\d{2})(?:-01)?$/.exec(periodMonth)
  if (!m) {
    throw new Error(`reporting-snapshot: period must be YYYY-MM or YYYY-MM-01, got '${periodMonth}'`)
  }
  return `${m[1]}-${m[2]}-01`
}

/**
 * The recorded snapshot for a month, or null when it has never been closed.
 *
 * ABSENCE IS NOT A STATE. It means nobody has recorded this month, which is the
 * ordinary condition for every month — there is no longer an open/closed axis
 * for a caller to branch on, and any caller reaching for one is asking a
 * question this module no longer answers.
 */
export async function getReportingSnapshot(
  db: Pick<Tx, 'execute'>,
  periodMonth: string,
): Promise<ReportingSnapshotRow | null> {
  const pm = normalisePeriodMonth(periodMonth)
  const rows = await db.execute<{
    period_month: string
    closed_at: string
    closed_by: string | null
    basis: ReportingBasis
    snapshot_version: number
    attributed_usd: string
    chargeable_usd: string
    exempt_usd: string
  }>(sql`
    SELECT period_month::text AS period_month, closed_at::text AS closed_at,
           closed_by::text AS closed_by, basis, snapshot_version,
           attributed_usd::text, chargeable_usd::text, exempt_usd::text
      FROM reporting_snapshot WHERE period_month = ${pm}::date`)
  const r = [...rows][0]
  if (!r) return null
  return {
    periodMonth: r.period_month,
    closedAt: r.closed_at,
    closedBy: r.closed_by,
    basis: r.basis,
    snapshotVersion: Number(r.snapshot_version),
    attributedUsd: Number(r.attributed_usd),
    chargeableUsd: Number(r.chargeable_usd),
    exemptUsd: Number(r.exempt_usd),
  }
}

export interface CloseReportingSnapshotResult {
  snapshot: ReportingSnapshotRow
}

/**
 * Record what this month currently reads, and mark it closed.
 *
 * Idempotence is deliberately NOT offered: closing a month twice would silently
 * replace the record of what was reported the first time, which is the one
 * thing a snapshot exists to preserve. A second call is an error.
 */
export async function closeReportingSnapshot(
  tx: Tx,
  args: {
    periodMonth: string
    actorTeammateId: string
    basis?: ReportingBasis
    ipAddress?: string | null
    userAgent?: string | null
  },
): Promise<CloseReportingSnapshotResult> {
  const pm = normalisePeriodMonth(args.periodMonth)
  await tx.execute(advisoryXactLock('reportingSnapshot', pm))

  const existing = [
    ...(await tx.execute<{ period_month: string }>(sql`
      SELECT period_month::text AS period_month FROM reporting_snapshot
       WHERE period_month = ${pm}::date FOR UPDATE`)),
  ][0]
  if (existing) {
    throw new ReportingSnapshotError(`reporting snapshot for ${pm} already exists`, 'already-closed')
  }

  /*
   * `basis` defaults to the only basis that exists today. Phase 4 makes it a
   * platform setting and passes it in; recording it now means a delta taken
   * after that change can tell "money moved" from "we changed how we count"
   * instead of subtracting two different questions.
   */
  const basis: ReportingBasis = args.basis ?? 'project-homed'

  const [totals] = [...(await tx.execute<{ attributed: string; chargeable: string; exempt: string }>(monthTotalsSql(pm)))]

  await tx.execute(sql`
    INSERT INTO reporting_snapshot
      (period_month, closed_at, closed_by, basis, snapshot_version,
       attributed_usd, chargeable_usd, exempt_usd)
    VALUES (${pm}::date, now(), ${args.actorTeammateId}::uuid, ${basis}, ${SNAPSHOT_VERSION},
            ${totals?.attributed ?? '0'}::numeric, ${totals?.chargeable ?? '0'}::numeric,
            ${totals?.exempt ?? '0'}::numeric)`)

  const snapshot = await getReportingSnapshot(tx, pm)

  await recordAuditEvent(tx, {
    eventType: 'reporting-snapshot-closed',
    actorTeammateId: args.actorTeammateId,
    subjectKind: 'reporting-snapshot',
    subjectId: null,
    payload: {
      period_month: pm,
      basis,
      snapshot_version: SNAPSHOT_VERSION,
      attributed_usd: snapshot?.attributedUsd ?? 0,
      chargeable_usd: snapshot?.chargeableUsd ?? 0,
      exempt_usd: snapshot?.exemptUsd ?? 0,
    },
    ipAddress: args.ipAddress ?? null,
    userAgent: args.userAgent ?? null,
  })

  return { snapshot: snapshot! }
}

/** What a recorded month reads NOW, beside what it read when it was closed. */
export interface ReportingSnapshotDelta {
  periodMonth: string
  closedAt: string
  basis: ReportingBasis
  /**
   * True when the CHARGEABLE lane still reads what was recorded.
   *
   * DELIBERATELY NOT "nothing moved at all". Attributed usage changes routinely
   * after a month ends — late OTel, a reconciliation rerun, somebody tagging a
   * session — so a flag that fired on any movement would mark every recorded
   * month as changed and mean nothing. §B is the lane finance read and acted
   * on, so §B movement is the signal; §A movement is reported as context and
   * does not raise this.
   */
  chargeableUnchanged: boolean
  /** Attributed movement, reported without alarm. Expected to be non-zero. */
  attributedMoved: boolean
  /**
   * Set when the two cannot honestly be subtracted — a basis or version change.
   * The figures are still returned; what is withheld is the arithmetic.
   */
  incomparableReason: 'basis-changed' | 'version-changed' | null
  /** 0 = closed before totals were captured; its `snapshot` figures are absent, not zero. */
  snapshotVersion: number
  snapshot: { attributedUsd: number; chargeableUsd: number; exemptUsd: number }
  current: { attributedUsd: number; chargeableUsd: number; exemptUsd: number }
  deltaUsd: { attributed: number; chargeable: number; exempt: number } | null
}

/**
 * Compare a recorded month against what it reads now.
 *
 * REFUSES TO SUBTRACT ACROSS A BASIS OR VERSION CHANGE. A month recorded under
 * `project-homed` and now read under `person-placed` has not moved by the
 * difference — the difference is what changing the question costs, and
 * presenting it as movement would be a confident wrong number. Both figures are
 * still returned; only `deltaUsd` is withheld, with the reason named.
 */
export async function reportingSnapshotDelta(
  db: Pick<Tx, 'execute'>,
  periodMonth: string,
  opts: { currentBasis?: ReportingBasis } = {},
): Promise<ReportingSnapshotDelta | null> {
  const pm = normalisePeriodMonth(periodMonth)
  const snap = await getReportingSnapshot(db, pm)
  if (!snap) return null

  const [now] = [...(await db.execute<{ attributed: string; chargeable: string; exempt: string }>(monthTotalsSql(pm)))]
  const current = {
    attributedUsd: Number(now?.attributed ?? 0),
    chargeableUsd: Number(now?.chargeable ?? 0),
    exemptUsd: Number(now?.exempt ?? 0),
  }
  const snapshot = {
    attributedUsd: snap.attributedUsd,
    chargeableUsd: snap.chargeableUsd,
    exemptUsd: snap.exemptUsd,
  }

  const currentBasis = opts.currentBasis ?? snap.basis
  const incomparableReason: ReportingSnapshotDelta['incomparableReason'] =
    snap.snapshotVersion !== SNAPSHOT_VERSION
      ? 'version-changed'
      : currentBasis !== snap.basis
        ? 'basis-changed'
        : null

  const deltaUsd = incomparableReason
    ? null
    : {
        attributed: current.attributedUsd - snapshot.attributedUsd,
        chargeable: current.chargeableUsd - snapshot.chargeableUsd,
        exempt: current.exemptUsd - snapshot.exemptUsd,
      }

  return {
    periodMonth: pm,
    closedAt: snap.closedAt,
    basis: snap.basis,
    // Exposed so a reader can tell "the month read $0.00" from "the figures
    // were never recorded": version 0 is a month closed under the old
    // machinery, which stored a state and no totals (mig 0128).
    snapshotVersion: snap.snapshotVersion,
    // A cent of tolerance: numeric(14,6) round-trips, and a month that has
    // genuinely not moved must not report a floating-point tremor.
    //
    // `exempt` counts as chargeable movement: a verdict flip moves money
    // between chargeable and exempt without changing either total on its own,
    // and that is precisely the case exempt_usd was snapshotted to expose.
    chargeableUnchanged: deltaUsd
      ? Math.abs(deltaUsd.chargeable) < 0.005 && Math.abs(deltaUsd.exempt) < 0.005
      : false,
    attributedMoved: deltaUsd ? Math.abs(deltaUsd.attributed) >= 0.005 : false,
    incomparableReason,
    snapshot,
    current,
    deltaUsd,
  }
}
