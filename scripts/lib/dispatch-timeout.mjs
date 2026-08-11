/*
 * Resolve the cron trigger's timeout from the environment.
 *
 * Its own module (plain .mjs, no deps) so the parsing is testable: cron-trigger.mjs
 * has top-level await and calls process.exit, so importing it from a test would run
 * it. This function is the only part with a decision in it.
 *
 * `Number(...)` alone is not enough. `Number('')`, `Number('200s')` and
 * `Number(undefined)` give 0 or NaN, and `setTimeout(fn, NaN)` fires on the NEXT
 * TICK -- so a typo'd env var would abort the fetch instantly and report a FAILED
 * execution for a worker that was never given a chance to run. That is precisely the
 * false-failure mode this whole change exists to remove, so it must not be
 * reintroducible by a bad string in the bicep.
 */

/**
 * @param {string | undefined} raw   the CRON_TRIGGER_TIMEOUT_MS env value
 * @param {number} fallback          the compiled-in default
 * @param {(msg: string) => void} [warn]  where to report a rejected value
 * @returns {number} a positive, finite millisecond count
 */
export function resolveTimeoutMs(raw, fallback, warn = console.warn) {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    // Fall back rather than exit: one bad value should not stop every worker in the
    // fleet from dispatching. Loud, because a silently-ignored override is how a
    // deliberate change goes missing.
    warn(
      `[cron-trigger] ignoring invalid CRON_TRIGGER_TIMEOUT_MS=${JSON.stringify(raw)} — using ${fallback}ms`,
    )
    return fallback
  }
  return n
}
