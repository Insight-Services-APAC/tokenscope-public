/*
 * attribution-stall — the USER-facing attribution-stall signal (ops-alerting
 * §A6.2, the §A2.2 signal SHAPE).
 *
 * Feeds the degradation banner on Home and /usage via the `attribution_stall`
 * payload leg: "Attribution has not landed data since <time>". The condition is
 * §A2.2's, NOT `MAX(ts_recorded)` (ar-H2 — re-tags/re-homes advance that during
 * an outage): the joiner's ZERO-WRITE STREAK (consecutive completed
 * azure-monitor-read runs that attributed 0 rows) has persisted for at least
 * OPS_ALERT_STALL_MINUTES, COMBINED with INGEST-SIDE work evidence
 * (streakSourceCoverage: the DCR received rows the joiner did not land), falling
 * back to recent emit activity (`instance_attestation.last_bearer_at`) only when
 * the coverage probe cannot measure. Idle estate = no banner.
 *
 * This module holds the ONE §A2.2 decision function, `decideAttributionStall`:
 * the ops-alert worker (§A6.3) and this user-facing helper both call it, and
 * both read the ledger through read-path-health.ts's exported loaders
 * (`loadReaderRuns` / `loadLastFleetEmitMs`) — the operator page, the user
 * banner and the phone can never disagree because there is one decision and
 * one query to disagree about. The loaders' exclusions (scoped recovery
 * batches, in-flight rows) are part of that contract; see read-path-health.ts
 * for the incident behind each clause.
 *
 * This is a GLOBAL operational signal: callers pass the BASE db handle, not a
 * request-RLS transaction. `instance_attestation` carries a region-scope RLS
 * policy, so a viewer-scoped MAX(last_bearer_at) would give two users in
 * different regions two different stall verdicts — the one thing §A6 exists to
 * prevent. `worker_run` is an ops ledger; nothing user-scoped leaves this
 * module (the payload leg is a single timestamp).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import {
  loadReaderRuns,
  loadLastFleetEmitMs,
  zeroWriteStreak,
  streakSourceCoverage,
  type StallCoverageBasis,
} from '../workers/read-path-health'
import type { SourceCoverageStatus } from '../azure/dcr-metrics'

type Db = PostgresJsDatabase<typeof schema>

/**
 * Default for OPS_ALERT_STALL_MINUTES (§A2.2): emitting + the joiner writing
 * nothing for this long = degraded. ONE constant — the ops-alert worker (B1)
 * imports it rather than re-declaring the number.
 */
export const OPS_ALERT_STALL_MINUTES_DEFAULT = 90

/**
 * The stall window in minutes — `OPS_ALERT_STALL_MINUTES`, read at CALL time
 * (the base-allowance.ts rule: env may be materialised from Key Vault after
 * import; tests set it between cases). Unset/unparseable/non-positive = the
 * default.
 */
export function opsAlertStallMinutes(): number {
  const parsed = Number(process.env.OPS_ALERT_STALL_MINUTES)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : OPS_ALERT_STALL_MINUTES_DEFAULT
}

/** The wire leg: `attribution_stall: { since } | null`. `since` is an ISO instant. */
export interface AttributionStall {
  /** When the zero-write streak began — the oldest consecutive zero-write run. */
  since: string
}

/** One completed, non-scoped reader run, most-recent-first (see the loaders). */
export interface StallRun {
  status: string // 'success' | 'failure' (running rows are excluded)
  startedAtMs: number
  /** worker_run.rows_affected; null = unknown outcome, breaks the streak. */
  rowsAffected: number | null
  /**
   * result->>'sessionsProcessed' — the size of the reader's SELECTION. Carried
   * for diagnostics; NOT read by the decision (an idle open editor keeps it at
   * 1, which is why PR #307's guard on it did not close the false positive).
   */
  sessionsProcessed: number | null
  /**
   * result->'sourceCoverage'->>'status' — the INGEST-SIDE coverage verdict (see
   * read-path-health.ts / server/azure/dcr-metrics.ts). THE work-evidence term.
   * null = not measured = unknown → bearer fallback.
   */
  sourceCoverage: SourceCoverageStatus | null
}

export interface StallDecisionInput {
  /** Recent completed reader runs, MOST-RECENT FIRST (started_at DESC). */
  runs: StallRun[]
  /** MAX(instance_attestation.last_bearer_at) epoch-ms; null = never. */
  lastFleetEmitMs: number | null
  nowMs: number
  stallMinutes: number
}

/** A positive stall verdict; `zeroRuns` is the ntfy aggregate-count leg (§A1). */
export interface StallVerdict extends AttributionStall {
  /** Length of the zero-write streak, in runs. */
  zeroRuns: number
  /**
   * Which ingest-coverage basis fired the stall (D1). 'source-backlog' — the DCR
   * received rows the joiner did not land; 'coverage-unknown-bearer-fresh' — the
   * probe could not measure, fell back to the bearer gate. The ops-alert worker
   * maps this to its OpsAlertReason so an operator can tell them apart.
   */
  basis: StallCoverageBasis
}

/*
 * PURE §A2.2 decision — no DB, and the ONLY stall decision in the codebase
 * (docs/design/ops-alerting.md A2.2/A6.3: operator page, user banner and phone
 * evaluate THIS function). Stall iff:
 *  1. the zero-write streak — the consecutive most-recent terminal runs with
 *     rows_affected === 0, where a FAILED run does NOT break the streak but a
 *     null (unrecorded outcome) does (zeroWriteStreak) — contains at least one
 *     SUCCESS: a joiner that only ever fails is the worker-fleet condition
 *     (§A2.3), not a stall claim this module can prove;
 *  2. the streak has PERSISTED for the whole window: its oldest run started at
 *     or before `now - stallMinutes`. §A2.2 is "writing nothing FOR
 *     OPS_ALERT_STALL_MINUTES", inherently time-integrated;
 *  3. WORK EVIDENCE from the INGEST-SIDE coverage verdict (streakSourceCoverage,
 *     shared with read-path-health) over the same streak — a signal independent
 *     of the reader's own output (the reason PR #316's reader-derived
 *     `newEventsSeen` gate was held: a reader that returns empty ON SUCCESS
 *     reads healthy). 'rows-arrived' → the DCR received rows the joiner did not
 *     land → page (basis 'source-backlog'), regardless of the bearer.
 *     'no-rows' → nothing arrived → the idle estate → silent. 'unknown' → the
 *     probe could not measure → fall back to the bearer gate (last_bearer_at
 *     fresh within the window → page, basis 'coverage-unknown-bearer-fresh'),
 *     which fails toward paging. A bearer is a 29-min keep-alive from any open
 *     editor — evidence the fleet is alive, never that there is usage to land —
 *     so it is only the fallback. Observed on Dev 2026-08-30: a 9-hour critical
 *     page through a Sunday in which nothing was being emitted; the coverage
 *     verdict for that estate is 'no-rows'.
 */
export function decideAttributionStall(input: StallDecisionInput): StallVerdict | null {
  const { runs, lastFleetEmitMs, nowMs, stallMinutes } = input
  const windowMs = stallMinutes * 60_000

  // The zero-write streak: the consecutive most-recent runs that all recorded
  // EXACTLY 0 rows. A null (unknown) or a >0 run ends it. ONE definition, shared
  // with read-path-health (zeroWriteStreak) so identical history clears/holds
  // both alerts the same.
  const streak = zeroWriteStreak(runs)
  if (streak.length === 0) return null

  // A streak that never SUCCEEDED is the worker-fleet lane's problem (§A2.3),
  // not a stall claim this module can prove.
  if (!streak.some((r) => r.status === 'success')) return null

  // Persistence (3): the streak must have held for the whole window.
  const oldest = streak[streak.length - 1]!
  if (oldest.startedAtMs > nowMs - windowMs) return null

  // Work evidence (1b): the INGEST-SIDE coverage verdict over the SAME streak
  // (streakSourceCoverage — independent of the reader's own output).
  const coverage = streakSourceCoverage(streak)
  let basis: StallCoverageBasis
  if (coverage === 'rows-arrived') {
    // The pipeline received rows the joiner did not land: a real backlog. Page
    // regardless of the bearer — a burst the reader never landed, then the
    // editor closed, is still a stall (today it would be silent).
    basis = 'source-backlog'
  } else if (coverage === 'no-rows') {
    // Nothing arrived: the idle-but-open-editor estate. Never a stall.
    return null
  } else {
    // 'unknown' — the probe could not measure. Fall back to today's bearer gate
    // (fresh mints within the window). Fails toward paging; A2.1 already pages
    // for a probe/LA outage.
    const fleetEmitting = lastFleetEmitMs !== null && nowMs - lastFleetEmitMs <= windowMs
    if (!fleetEmitting) return null
    basis = 'coverage-unknown-bearer-fresh'
  }

  return { since: new Date(oldest.startedAtMs).toISOString(), zeroRuns: streak.length, basis }
}

/**
 * The §A2.2 stall signal against the ledger, projected to the wire leg. Reads
 * ONLY through read-path-health.ts's exported loaders — no duplicate SQL; the
 * loaders' scoped-run and running-row exclusions are the shared contract.
 * Never throws into the caller's payload path is the CALLER's concern — this
 * helper itself only reads.
 */
export async function attributionStall(
  db: Db,
  opts?: { now?: Date; stallMinutes?: number },
): Promise<AttributionStall | null> {
  const now = opts?.now ?? new Date()
  const stallMinutes = opts?.stallMinutes ?? opsAlertStallMinutes()

  const runs = await loadReaderRuns(db)
  const lastFleetEmitMs = await loadLastFleetEmitMs(db)

  const verdict = decideAttributionStall({ runs, lastFleetEmitMs, nowMs: now.getTime(), stallMinutes })
  return verdict === null ? null : { since: verdict.since }
}
