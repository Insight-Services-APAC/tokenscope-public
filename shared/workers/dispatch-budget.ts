/*
 * The dispatch budget — how long a scheduled worker's HTTP trigger may take.
 *
 * A worker runs in two places, and only one of them writes the ledger:
 *
 *   ACA cron job  ->  scripts/cron-trigger.mjs  --POST-->  /internal/run-worker
 *   (replicaTimeout)   (CRON_TRIGGER_TIMEOUT_MS)            (writes worker_run)
 *
 * The server does the work and records `success`. The trigger only waits for the
 * reply. So a worker that takes LONGER than the trigger is willing to wait
 * completes perfectly, writes `success`, and is still reported as a FAILED job
 * execution -- because the trigger aborted the fetch and exited 1. The platform
 * then retries it (replicaRetryLimit), running a second copy against the same
 * advisory lock.
 *
 * That is not hypothetical. On Dev, 2026-07: region-reenrichment ran 134_520ms
 * server-side and logged `success` every time, while its job execution failed 73
 * consecutive times; analytics-poll ran 108_327ms and failed ~50% of executions,
 * flipping a coin against the 120s the trigger allowed. Admin -> Diagnostics
 * showed both as `ok`, because from the ledger's point of view they WERE ok. The
 * red lived in Azure, the green lived in the product, and neither surface could
 * see the other.
 *
 * So the budget is a shared constant rather than a number that happens to appear
 * in three places. It is consumed by:
 *   - infra/modules/worker-jobs.bicep  (sets CRON_TRIGGER_TIMEOUT_MS per job)
 *   - scripts/cron-trigger.mjs         (its fallback when the env is unset)
 *   - the diagnostics read path        (classifies each run against it)
 * and tests/unit/workers/dispatch-budget-lockstep.test.ts asserts all three
 * agree, because drift between them is exactly the failure above.
 */

/**
 * How long the cron trigger waits for the run-worker response, in ms.
 *
 * MUST stay below the ACA `replicaTimeout` (see REPLICA_TIMEOUT_SECONDS): the
 * trigger aborting is a clean `exit(1)` with a log line naming the worker, while
 * the platform killing the replica is a hard stop with no such line. We want the
 * legible failure to win the race.
 */
export const DISPATCH_TIMEOUT_MS = 200_000

/**
 * The ACA replica timeout, in seconds. Declared here so the ordering invariant
 * against DISPATCH_TIMEOUT_MS is checkable in one place; the bicep is the thing
 * that actually applies it.
 */
export const REPLICA_TIMEOUT_SECONDS = 240

/**
 * Fraction of the budget above which a run is "near" it. A run at 80% is not
 * failing today, but it is one slow directory call away from flipping -- which
 * is the state analytics-poll sat in for weeks before it started failing half
 * its executions. Warn while it is still cheap to act on.
 */
export const DISPATCH_NEAR_FRACTION = 0.8

export type DispatchBudgetState = 'ok' | 'near' | 'over'

/**
 * Classify a completed run's duration against the dispatch budget.
 *
 * `over` means the job execution was reported as FAILED even if the ledger says
 * success, and a retry ran a duplicate. `near` means it is about to be.
 * A null/negative duration is unclassifiable, not healthy -- it returns null so
 * a caller cannot mistake "we do not know" for "fine".
 */
export function classifyDispatchDuration(durationMs: number | null | undefined): DispatchBudgetState | null {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return null
  if (durationMs >= DISPATCH_TIMEOUT_MS) return 'over'
  if (durationMs >= DISPATCH_TIMEOUT_MS * DISPATCH_NEAR_FRACTION) return 'near'
  return 'ok'
}

/** Human-readable reason for a non-ok state, or null when there is nothing to say. */
export function dispatchBudgetReason(state: DispatchBudgetState | null, durationMs: number | null): string | null {
  if (state === 'over') {
    // "at or past", not "past": the classifier boundary is `>=`, so a run landing
    // exactly on the budget is 'over' — the trigger's abort fires at that instant.
    return `ran ${fmtSeconds(durationMs)}, at or past the ${fmtSeconds(DISPATCH_TIMEOUT_MS)} dispatch budget — the cron trigger gives up and the platform reports this run as FAILED and retries it, even though the work itself finished`
  }
  if (state === 'near') {
    return `ran ${fmtSeconds(durationMs)} of the ${fmtSeconds(DISPATCH_TIMEOUT_MS)} dispatch budget — close enough that a slower run will be reported as failed and retried`
  }
  return null
}

function fmtSeconds(ms: number | null): string {
  if (ms == null) return 'unknown'
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}
