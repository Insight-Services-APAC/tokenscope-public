/*
 * Workers that are REGISTERED but deliberately have NO Container Apps cron.
 *
 * This list is shared on purpose. It used to live only in the lockstep test,
 * which meant the runtime had no way to tell "scheduled" from "registered but
 * never dispatched" — and the admin worker-controls card happily rendered a
 * `recommendedCron` next to a worker that has no job at all. An operator reading
 * that card would conclude `archive-ledger` runs monthly. It does not run, ever.
 * That is the silent-no-op illusion this whole epic exists to kill, reproduced in
 * the very UI built to expose it.
 *
 * tests/unit/workers/worker-schedule-lockstep.test.ts enforces this against
 * infra/modules/worker-jobs.bicep in BOTH directions, so an entry here cannot
 * drift from the deployed reality:
 *   - a worker listed here that IS scheduled fails the test (stale entry);
 *   - a worker missing from here AND from the bicep fails the test (silent gap).
 *
 * Rule: never add an entry to silence a failure. An entry means "we know, it is
 * tracked, and here is the concrete blocker".
 */
/*
 * NULL PROTOTYPE, deliberately — defence in depth, not the primary guard.
 *
 * The helpers below are the supported API and they use `Object.hasOwn`, which is
 * already prototype-safe. The null prototype protects the OTHER kind of access: a
 * naive `name in UNSCHEDULED_WORKERS` or `UNSCHEDULED_WORKERS[name]` written at a
 * future call site, or this object being handed to code that iterates it. Against
 * a normal object literal a worker named `constructor` or `toString` would resolve
 * through the prototype chain — `in` reports true (worker wrongly shown as
 * unscheduled) and the indexed read yields a FUNCTION where a reason string gets
 * rendered into the admin card. No worker is named that today; this costs nothing
 * and removes the failure mode instead of relying on it staying that way.
 */
export const UNSCHEDULED_WORKERS: Record<string, string> = Object.assign(Object.create(null), {
  // A hard no-op until LEDGER_ARCHIVE_ENABLED=true, so SCHEDULING it is harmless —
  // but ENABLING is blocked on an unbuilt v_complete_usage §A cold-fallback
  // (archival DETACH+DROPs cold partitions that v_complete_usage reads directly,
  // so §A usage reporting would go dark for archived months). Schedule it as part
  // of the eventual enablement change, once the cold-fallback exists.
  'archive-ledger':
    'no-op until LEDGER_ARCHIVE_ENABLED; enabling blocked on an unbuilt v_complete_usage §A cold-fallback',
})

/**
 * False when `name` is on the deliberately-unscheduled list above.
 *
 * NOT a validity check: this is a membership test, so an unknown or misspelled
 * name returns TRUE ("not listed" reads as "scheduled"). Callers must establish
 * that the name IS a registered worker first — enablement.put.ts rejects unknown
 * names before reaching this, and the enablement GET only ever maps over WORKERS.
 * Used alone on unvalidated input it would wave a typo through as scheduled.
 */
export function isWorkerScheduled(name: string): boolean {
  return !Object.hasOwn(UNSCHEDULED_WORKERS, name)
}

/**
 * Why this worker has no cron, or null when it is not on the list. Same caveat as
 * isWorkerScheduled: an unknown name yields null, which reads as "scheduled".
 */
export function unscheduledReason(name: string): string | null {
  return Object.hasOwn(UNSCHEDULED_WORKERS, name) ? UNSCHEDULED_WORKERS[name]! : null
}
