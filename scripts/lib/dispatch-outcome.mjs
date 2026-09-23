/*
 * Classify a run-worker HTTP response into a cron-job exit code.
 *
 * Its own module (plain .mjs, no deps) for the same reason as dispatch-timeout.mjs:
 * cron-trigger.mjs has top-level await and calls process.exit, so importing it from
 * a test would run it. This function is the only part with a decision in it.
 *
 * THE CLASS THIS EXISTS TO CLOSE: a healthy outcome reported as a FAILED execution.
 * It has bitten this file twice.
 *   1. A 120s trigger timeout against a 240s replicaTimeout: any worker running
 *      longer finished its work, logged `success`, and was still reported FAILED and
 *      retried — 73 consecutive false failures on Dev. Fixed by the timeout lockstep.
 *   2. This one (#285). When a worker has a backlog, a run outlasts its own cron
 *      interval; the next tick hits the ING-3 single-flight lock and gets
 *      `409 worker-already-running`. That is the lock WORKING — the dispatch is a
 *      deliberate no-op and the caller simply tries again next tick — but `res.ok`
 *      is false for a 409, so the job execution recorded `Failed`:
 *
 *        23:15  Failed   <- worker running normally, catching up
 *        23:20  Failed   <- 409, previous run still holding the lock
 *        23:25  Succeeded
 *
 *      A catch-up was indistinguishable from a real outage in the job history, which
 *      is the signal an operator actually reads.
 *
 * WHY THIS MATCHES THE PROBLEM TYPE AND NOT THE BARE STATUS. Today `dispatchWorker`
 * has exactly one 409 path (the lock, server/workers/dispatch.ts), so matching on the
 * status alone would be correct right now and quietly wrong the first time someone
 * adds a second 409 for a reason that IS a failure. The ProblemDetails `type` names
 * the condition; the status only names its shape.
 *
 * The match is on the type's final PATH SEGMENT, not the whole URI and not a bare
 * suffix. Not the whole URI because the publish pipeline rewrites the internal host
 * in the public snapshot (tools/publish/substitutions.txt), so the origin is not a
 * stable string to compare against. Not a bare suffix because `endsWith` would also
 * accept `.../not-worker-already-running`, which is the opposite condition — that is
 * the fail-open hole a segment boundary closes.
 */

/** The ProblemDetails type's final path segment for the ING-3 single-flight no-op. */
export const ALREADY_RUNNING_TYPE = 'worker-already-running'

/**
 * @param {number} status        HTTP status from the run-worker endpoint
 * @param {string} bodyText      raw response body (may be empty or non-JSON)
 * @returns {{ exitCode: 0 | 1, skipped: boolean }}
 *   `skipped` marks the healthy no-op so the caller can log it as such: exit 0 with
 *   no explanation would make a suppressed failure and a skipped tick look alike in
 *   the log, having just made them look alike in the job history.
 */
export function classifyDispatchResponse(status, bodyText) {
  if (status >= 200 && status < 300) return { exitCode: 0, skipped: false }
  if (status === 409 && isAlreadyRunning(bodyText)) return { exitCode: 0, skipped: true }
  return { exitCode: 1, skipped: false }
}

/*
 * The token as a whole final path segment, so a longer token that merely ENDS with
 * it (`not-worker-already-running`) cannot match. A bare token with no slash is
 * accepted: `lastIndexOf('/')` returns -1 and the whole string is the segment.
 */
function isAlreadyRunningType(type) {
  if (typeof type !== 'string') return false
  return type.slice(type.lastIndexOf('/') + 1) === ALREADY_RUNNING_TYPE
}

/*
 * Raw-text fallback with the same boundary rule: the token must sit after a path
 * separator and must not be extended by another word character or hyphen. Without
 * the lookahead this would accept `worker-already-running-v2`; without the leading
 * slash it would accept `not-worker-already-running`.
 */
const RAW_TEXT_PATTERN = new RegExp(`/${ALREADY_RUNNING_TYPE}(?![\\w-])`)

/*
 * Read the ProblemDetails type out of the body. Tolerant by design: the body is
 * whatever the endpoint returned, and a parse failure must not turn a 409 into a
 * crash. The raw-text check is the fallback, because h3 nests ProblemDetails under
 * `data` and the exact envelope is not this script's contract.
 *
 * The fallback fails OPEN toward reporting a failure rather than swallowing one:
 * an unrecognised 409 body exits 1, which is noisy but never hides a real outage.
 */
function isAlreadyRunning(bodyText) {
  if (typeof bodyText !== 'string' || bodyText === '') return false
  try {
    const parsed = JSON.parse(bodyText)
    const type = parsed?.data?.type ?? parsed?.type
    if (typeof type === 'string') return isAlreadyRunningType(type)
  } catch {
    // Not JSON, or not the shape we expect — fall through to the text check.
  }
  return RAW_TEXT_PATTERN.test(bodyText)
}
