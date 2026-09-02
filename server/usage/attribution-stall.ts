/*
 * attribution-stall — the USER-facing attribution-stall signal (ops-alerting
 * §A6.2, the §A2.2 signal SHAPE).
 *
 * Feeds the degradation banner on Home and /usage via the `attribution_stall`
 * payload leg: "Attribution has not landed data since <time>". The condition is
 * §A2.2's, NOT `MAX(ts_recorded)` (ar-H2 — re-tags/re-homes advance that during
 * an outage): the joiner's ZERO-WRITE STREAK (consecutive completed
 * azure-monitor-read runs that attributed 0 rows) has persisted for at least
 * OPS_ALERT_STALL_MINUTES, COMBINED with recent emit activity
 * (`instance_attestation.last_bearer_at` inside the same window). Idle estate =
 * no banner.
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
import { loadReaderRuns, loadLastFleetEmitMs } from '../workers/read-path-health'

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
   * result->>'sessionsProcessed' — how many sessions the run actually LOOKED
   * AT. The evidence that there was work to do at all; without it a zero-write
   * run is an idle estate, not a stall. null = the run recorded no outcome.
   */
  sessionsProcessed: number | null
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
}

/*
 * PURE §A2.2 decision — no DB, and the ONLY stall decision in the codebase
 * (docs/design/ops-alerting.md A2.2/A6.3: operator page, user banner and phone
 * evaluate THIS function). Stall iff:
 *  1. the fleet emitted within the window (`last_bearer_at` — idle = silent);
 *  1b. AND the reader actually HAD WORK: at least one run in the streak
 *     processed a session. Condition 1 alone is a keep-alive, not evidence of
 *     usage — Claude Code runs its otelHeadersHelper at startup and every ~29
 *     minutes for the life of the process (claude-code-telemetry-contract.md),
 *     and every call stamps last_bearer_at. That is a third of the 90-minute
 *     window, so ONE editor left open holds "the fleet is emitting" true
 *     forever while the reader correctly writes nothing, and the alert fires on
 *     an idle estate. Observed on Dev 2026-08-30: a 9-hour critical page
 *     through a Sunday in which nothing was being emitted.
 *
 *     Requiring work evidence only NARROWS the condition, so it cannot
 *     introduce a false negative except in the case being removed. A reader
 *     that is failing outright records no sessions and so raises
 *     `worker:azure-monitor-read` / worker-fleet (§A2.3) instead — a different
 *     condition with its own page, which is the correct home for "the reader
 *     is down" as opposed to "the reader is running and producing nothing".
 *  2. the zero-write streak — the consecutive most-recent terminal runs with
 *     rows_affected === 0, where a FAILED run does NOT break the streak but a
 *     null (unrecorded outcome) does — contains at least one SUCCESS: a joiner
 *     that only ever fails is the worker-fleet condition (§A2.3), not a stall
 *     claim this module can prove;
 *  3. the streak has PERSISTED for the whole window: its oldest run started at
 *     or before `now - stallMinutes`. Without this, one zero-write tick minutes
 *     after a row-landing run would page — §A2.2 is "writing nothing FOR
 *     OPS_ALERT_STALL_MINUTES", inherently time-integrated.
 */
export function decideAttributionStall(input: StallDecisionInput): StallVerdict | null {
  const { runs, lastFleetEmitMs, nowMs, stallMinutes } = input
  const windowMs = stallMinutes * 60_000

  const fleetEmitting = lastFleetEmitMs !== null && nowMs - lastFleetEmitMs <= windowMs
  if (!fleetEmitting) return null

  // The zero-write streak: the consecutive most-recent runs that all recorded
  // EXACTLY 0 rows. A null (unknown) or a >0 run ends it — read-path-health.ts.
  let streakEnd = 0
  while (streakEnd < runs.length && runs[streakEnd]!.rowsAffected === 0) streakEnd += 1
  if (streakEnd === 0) return null

  const streak = runs.slice(0, streakEnd)
  if (!streak.some((r) => r.status === 'success')) return null
  // Work evidence (1b): a streak of runs that each looked at NOTHING is an idle
  // estate, not a stall. sessionsProcessed is already carried on every run.
  if (!streak.some((r) => (r.sessionsProcessed ?? 0) > 0)) return null

  const oldest = streak[streak.length - 1]!
  if (oldest.startedAtMs > nowMs - windowMs) return null

  return { since: new Date(oldest.startedAtMs).toISOString(), zeroRuns: streak.length }
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
