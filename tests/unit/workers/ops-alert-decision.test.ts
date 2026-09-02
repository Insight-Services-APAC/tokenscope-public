// @vitest-environment node
/*
 * The ops-alert worker's PURE decision logic (docs/design/ops-alerting.md
 * A2.2/A2.3/A3):
 *   - cronIntervalMs / workerDeadlineMs — the cadence-aware deadline inputs
 *     (ar-M13), pinned against every shape the live registry uses;
 *   - isWorkerFailing — the per-worker fleet predicate (ar-M11/M12);
 *   - decideAttributionStall — the ONE A2.2 stall decision (ar-H2), shared
 *     with the A6.2 user banner via server/usage/attribution-stall.ts;
 *   - decideConditionAction — the A3 state machine step, incl. the branch no
 *     natural producer exercises today (same-key severity ESCALATION, ar-M15)
 *     and the D3 amendment (docs/design/alert-diagnosability.md): damping is
 *     severity-INDEPENDENT, so a critical is announced on its second
 *     consecutive observation, not its first.
 * DB-coupled behaviour lives in tests/integration/workers/ops-alert.test.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  FLEET_LOOKBACK_MS,
  WEDGED_RUNNING_MS,
  cronIntervalMs,
  decideConditionAction,
  isWorkerFailing,
  workerDeadlineMs,
  type ConditionObservation,
  type ConditionState,
} from '../../../server/workers/ops-alert'
import { decideAttributionStall } from '../../../server/usage/attribution-stall'
import { WORKERS } from '../../../server/workers/registry'
import type { ReaderRun } from '../../../server/workers/read-path-health'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.parse('2026-07-15T12:00:00Z')

describe('cronIntervalMs (ar-M13 input)', () => {
  it('parses every cadence shape the registry uses', () => {
    expect(cronIntervalMs('*/5 * * * *')).toBe(5 * MIN)
    expect(cronIntervalMs('*/15 * * * *')).toBe(15 * MIN)
    expect(cronIntervalMs('9,24,39,54 * * * *')).toBe(15 * MIN) // worst-case circular gap
    expect(cronIntervalMs('7,52 * * * *')).toBe(45 * MIN) // uneven list → widest gap
    expect(cronIntervalMs('0 * * * *')).toBe(HOUR)
    expect(cronIntervalMs('0 */6 * * *')).toBe(6 * HOUR)
    expect(cronIntervalMs('30 4 * * *')).toBe(DAY)
    expect(cronIntervalMs('50 23 * * 0')).toBe(7 * DAY)
    expect(cronIntervalMs('0 4 1 * *')).toBe(31 * DAY)
  })

  it('returns null for shapes it cannot price (degrade loudly, never misclassify)', () => {
    expect(cronIntervalMs('')).toBeNull()
    expect(cronIntervalMs('* * *')).toBeNull()
    // A zero step is not a cadence — it must route to the skip-with-warn path,
    // never a 0ms interval quietly widening to the 1h deadline floor.
    expect(cronIntervalMs('*/0 * * * *')).toBeNull()
    expect(cronIntervalMs('0 */0 * * *')).toBeNull()
    expect(cronIntervalMs('5 * * * *')).toBe(HOUR) // single fixed minute per hour
    expect(cronIntervalMs('61 * * * *')).toBeNull() // out-of-range minute
    expect(cronIntervalMs('99,120 * * * *')).toBeNull() // out-of-range list minutes
    expect(cronIntervalMs('*/x * * * *')).toBeNull()
  })

  it('parses EVERY live registry recommendedCron — a new cron shape must extend the parser', () => {
    for (const w of WORKERS) {
      expect(cronIntervalMs(w.recommendedCron), `unparseable cron for ${w.name}: '${w.recommendedCron}'`).not.toBeNull()
    }
  })
})

describe('workerDeadlineMs — 3× interval, min 1 h (ar-M13)', () => {
  it('clamps fast cadences to the 1 h floor and scales slow ones', () => {
    expect(workerDeadlineMs('*/5 * * * *')).toBe(HOUR) // 3×5min < 1h → floor
    expect(workerDeadlineMs('*/30 * * * *')).toBe(90 * MIN)
    expect(workerDeadlineMs('0 */6 * * *')).toBe(18 * HOUR)
    expect(workerDeadlineMs('50 23 * * 0')).toBe(21 * DAY)
    expect(workerDeadlineMs('nonsense')).toBeNull()
  })
})

function fleetRuns(specs: Array<[status: string, agoMs: number]>) {
  return specs.map(([status, agoMs]) => ({ status, startedAtMs: NOW - agoMs }))
}

describe('isWorkerFailing — the A2.3 per-worker predicate', () => {
  const base = { deadlineMs: HOUR, nowMs: NOW, lastSuccessMs: null }

  it('two consecutive failures + missed deadline = failing', () => {
    const v = isWorkerFailing({ ...base, runs: fleetRuns([['failure', 10 * MIN], ['failure', 25 * MIN]]) })
    expect(v).toEqual({ failing: true, streak: 2 })
  })

  it('a single failure never fires', () => {
    const v = isWorkerFailing({ ...base, runs: fleetRuns([['failure', 10 * MIN]]) })
    expect(v.failing).toBe(false)
  })

  it('SKIPPED resets the streak (ar-M12 — disable/re-enable must not resurrect old failures)', () => {
    const v = isWorkerFailing({
      ...base,
      runs: fleetRuns([['failure', 10 * MIN], ['skipped', 25 * MIN], ['failure', 40 * MIN], ['failure', 55 * MIN]]),
    })
    expect(v).toEqual({ failing: false, streak: 1 })
  })

  it('success resets the streak', () => {
    const v = isWorkerFailing({
      ...base,
      runs: fleetRuns([['failure', 10 * MIN], ['success', 25 * MIN], ['failure', 40 * MIN]]),
      lastSuccessMs: NOW - 25 * MIN,
    })
    expect(v.failing).toBe(false)
  })

  it('a WEDGED running row (older than 2× the dispatch budget) counts as a failure (ar-M12)', () => {
    const wedgedAgo = WEDGED_RUNNING_MS + MIN
    const v = isWorkerFailing({ ...base, runs: fleetRuns([['running', wedgedAgo], ['failure', wedgedAgo + 15 * MIN]]) })
    expect(v).toEqual({ failing: true, streak: 2 })
  })

  it('a FRESH running row is no evidence either way (skipped over, not reset)', () => {
    const v = isWorkerFailing({ ...base, runs: fleetRuns([['running', MIN], ['failure', 20 * MIN]]) })
    expect(v).toEqual({ failing: false, streak: 1 })
    // …but two completed failures behind a fresh running row still count.
    const v2 = isWorkerFailing({
      ...base,
      runs: fleetRuns([['running', MIN], ['failure', 20 * MIN], ['failure', 35 * MIN]]),
    })
    expect(v2).toEqual({ failing: true, streak: 2 })
  })

  it('cadence-aware deadline: a success inside the deadline suppresses the page', () => {
    const runs = fleetRuns([['failure', 10 * MIN], ['failure', 25 * MIN]])
    const within = isWorkerFailing({ runs, deadlineMs: 18 * HOUR, nowMs: NOW, lastSuccessMs: NOW - 2 * HOUR })
    expect(within.failing).toBe(false)
    const missed = isWorkerFailing({ runs, deadlineMs: 18 * HOUR, nowMs: NOW, lastSuccessMs: NOW - 20 * HOUR })
    expect(missed.failing).toBe(true)
  })

  it('a deadline wider than the 8-day lookback can never be ESTABLISHED (ar-M14 residual)', () => {
    const weekly = isWorkerFailing({
      runs: fleetRuns([['failure', 10 * MIN], ['failure', DAY]]),
      deadlineMs: 21 * DAY, // > FLEET_LOOKBACK_MS
      nowMs: NOW,
      lastSuccessMs: null,
    })
    expect(21 * DAY).toBeGreaterThan(FLEET_LOOKBACK_MS)
    expect(weekly.failing).toBe(false)
  })

  it('an unparseable cron (deadline null) never fires', () => {
    const v = isWorkerFailing({
      runs: fleetRuns([['failure', 10 * MIN], ['failure', 25 * MIN]]),
      deadlineMs: null,
      nowMs: NOW,
      lastSuccessMs: null,
    })
    expect(v.failing).toBe(false)
  })
})

function readerRun(agoMs: number, rowsAffected: number | null, status = 'success'): ReaderRun {
  return { status, startedAtMs: NOW - agoMs, rowsAffected, sessionsProcessed: 5, errors: 0 }
}

describe('decideAttributionStall (A2.2, ar-H2 — the UNIFIED streak semantic)', () => {
  const STALL_MINUTES = 90

  it('pages when the zero-write streak spans the window while the fleet still emits', () => {
    const runs = [readerRun(5 * MIN, 0), readerRun(35 * MIN, 0), readerRun(65 * MIN, 0), readerRun(95 * MIN, 0)]
    const v = decideAttributionStall({ runs, lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES })
    expect(v).toEqual({ since: new Date(NOW - 95 * MIN).toISOString(), zeroRuns: 4 })
  })

  it('a LAPTOP LEFT ON is silent — bearer fresh, but nothing was ever processed', () => {
    /*
     * The false positive this condition shipped with, and the reason it paged a
     * phone at 03:00 on a Sunday.
     *
     * `last_bearer_at` is stamped by the /bearer mint, and Claude Code runs its
     * otelHeadersHelper at startup and every ~29 minutes for the life of the
     * process (claude-code-telemetry-contract.md) — a THIRD of the 90-minute
     * window. So one editor left open holds "the fleet is emitting" true
     * indefinitely while emitting nothing, the reader correctly writes zero
     * rows every tick, and the streak grows until it pages at severity
     * critical, which is ntfy priority 5 and overrides Do Not Disturb.
     *
     * The fix is work evidence: a streak in which no run ever LOOKED AT a
     * session is an idle estate, not a stall.
     */
    const idle = [
      { status: 'success', startedAtMs: NOW - 5 * MIN, rowsAffected: 0, sessionsProcessed: 0, errors: 0 },
      { status: 'success', startedAtMs: NOW - 35 * MIN, rowsAffected: 0, sessionsProcessed: 0, errors: 0 },
      { status: 'success', startedAtMs: NOW - 95 * MIN, rowsAffected: 0, sessionsProcessed: 0, errors: 0 },
    ] as ReaderRun[]
    expect(
      decideAttributionStall({
        // Minted 10 minutes ago by a process that did no work — the keep-alive.
        runs: idle,
        lastFleetEmitMs: NOW - 10 * MIN,
        nowMs: NOW,
        stallMinutes: STALL_MINUTES,
      }),
    ).toBeNull()
  })

  it('still pages when the reader HAD work and wrote nothing', () => {
    // The other side of the same boundary: work evidence must not make the
    // condition unreachable. One processed session in the streak is enough.
    const working = [
      { status: 'success', startedAtMs: NOW - 5 * MIN, rowsAffected: 0, sessionsProcessed: 0, errors: 0 },
      { status: 'success', startedAtMs: NOW - 35 * MIN, rowsAffected: 0, sessionsProcessed: 3, errors: 0 },
      { status: 'success', startedAtMs: NOW - 95 * MIN, rowsAffected: 0, sessionsProcessed: 0, errors: 0 },
    ] as ReaderRun[]
    expect(
      decideAttributionStall({
        runs: working,
        lastFleetEmitMs: NOW - 10 * MIN,
        nowMs: NOW,
        stallMinutes: STALL_MINUTES,
      }),
    ).toEqual({ since: new Date(NOW - 95 * MIN).toISOString(), zeroRuns: 3 })
  })

  it('an IDLE estate is silent — no bearer mint inside the window (A2.2)', () => {
    const runs = [readerRun(5 * MIN, 0), readerRun(35 * MIN, 0), readerRun(95 * MIN, 0)]
    const v = decideAttributionStall({ runs, lastFleetEmitMs: NOW - 3 * HOUR, nowMs: NOW, stallMinutes: STALL_MINUTES })
    expect(v).toBeNull()
  })

  it('a row-writing run breaks the streak; a streak narrower than the window withholds', () => {
    const broken = decideAttributionStall({
      runs: [readerRun(5 * MIN, 0), readerRun(20 * MIN, 42), readerRun(95 * MIN, 0)],
      lastFleetEmitMs: NOW - 10 * MIN,
      nowMs: NOW,
      stallMinutes: STALL_MINUTES,
    })
    expect(broken).toBeNull()
    const narrow = decideAttributionStall({
      runs: [readerRun(5 * MIN, 0), readerRun(20 * MIN, 0)],
      lastFleetEmitMs: NOW - 10 * MIN,
      nowMs: NOW,
      stallMinutes: STALL_MINUTES,
    })
    expect(narrow).toBeNull()
  })

  it('a FAILED zero-row run does NOT break the streak (unified semantic, A2.2)', () => {
    const v = decideAttributionStall({
      runs: [readerRun(5 * MIN, 0, 'failure'), readerRun(35 * MIN, 0), readerRun(95 * MIN, 0)],
      lastFleetEmitMs: NOW - 10 * MIN,
      nowMs: NOW,
      stallMinutes: STALL_MINUTES,
    })
    expect(v).toEqual({ since: new Date(NOW - 95 * MIN).toISOString(), zeroRuns: 3 })
  })

  it('a PURE-FAILURE streak never fires — that is the worker-fleet lane, not a stall', () => {
    const v = decideAttributionStall({
      runs: [readerRun(5 * MIN, 0, 'failure'), readerRun(35 * MIN, 0, 'failure'), readerRun(95 * MIN, 0, 'failure')],
      lastFleetEmitMs: NOW - 10 * MIN,
      nowMs: NOW,
      stallMinutes: STALL_MINUTES,
    })
    expect(v).toBeNull()
  })
})

const REMIND = 6 * HOUR
const delivered = (severity: 'critical' | 'warning', lastSentAgoMs: number): ConditionState => ({
  severity,
  activeRuns: 3,
  delivered: true,
  lastSentAtMs: NOW - lastSentAgoMs,
  clearRuns: 0,
})

// Observations now carry a closed-enum reason (D1); the state machine itself
// never reads it, so these two stand in for "a critical" / "a warning".
const CRIT: ConditionObservation = { severity: 'critical', reason: 'probe-timeout' }
const WARN: ConditionObservation = { severity: 'warning', reason: 'items-aged' }

function persistedState(a: ReturnType<typeof decideConditionAction>) {
  expect(a.type).toBe('persist')
  return (a as Extract<typeof a, { type: 'persist' }>).state
}

describe('decideConditionAction — the A3 step', () => {
  it('CRITICAL is two-run damped like a warning (D3): one observation persists, two send', () => {
    // The D3 assertion. Reverting `damped` to the severity-scoped
    // `obs.severity === 'warning' && …` turns the first expectation red:
    // the critical sends on its first observation again.
    const first = decideConditionAction(null, CRIT, NOW, REMIND)
    expect(first.type).toBe('persist')
    expect(persistedState(first).activeRuns).toBe(1)

    const second = decideConditionAction(persistedState(first), CRIT, NOW + 15 * MIN, REMIND)
    expect(second).toMatchObject({ type: 'send', kind: 'alert', transition: 'critical→critical' })
  })

  it('WARNING takes two-run damping', () => {
    const first = decideConditionAction(null, WARN, NOW, REMIND)
    expect(first.type).toBe('persist')
    const firstState = persistedState(first)
    expect(firstState.activeRuns).toBe(1)
    const second = decideConditionAction(firstState, WARN, NOW + 15 * MIN, REMIND)
    expect(second).toMatchObject({ type: 'send', kind: 'alert', transition: 'warning→warning' })
  })

  it('ESCALATION warning→critical on a DELIVERED condition notifies immediately (ar-M15, unchanged by D3)', () => {
    // Delivered as a warning two minutes ago; the reminder cadence would hold
    // for hours — the severity flip must not. Damping lives in the UNDELIVERED
    // branch only, so D3 cannot reach this: the operator already has a warning
    // on screen and needs to know it got worse.
    const a = decideConditionAction(delivered('warning', 2 * MIN), CRIT, NOW, REMIND)
    expect(a).toMatchObject({ type: 'send', kind: 'alert', transition: 'warning→critical' })
  })

  it('a delivered condition reminds only when the cadence elapses', () => {
    const early = decideConditionAction(delivered('critical', 3 * HOUR), CRIT, NOW, REMIND)
    expect(early.type).toBe('persist')
    const due = decideConditionAction(delivered('critical', 7 * HOUR), CRIT, NOW, REMIND)
    expect(due).toMatchObject({ type: 'send', kind: 'reminder' })
  })

  it('an UNDELIVERED condition retries every run at the SAME severity (a failed POST left it retryable, ar-M16)', () => {
    const failedOnce: ConditionState = { severity: 'critical', activeRuns: 1, delivered: false, lastSentAtMs: null, clearRuns: 0 }
    const a = decideConditionAction(failedOnce, CRIT, NOW, REMIND)
    expect(a).toMatchObject({ type: 'send', kind: 'alert' })
  })

  it('damping is SEVERITY-SCOPED: an undelivered critical easing to warning restarts the two-run count', () => {
    // A critical whose page failed (undelivered, activeRuns 1) eases to warning:
    // the warning must NOT inherit the critical's run count — it waits for its
    // own second consecutive warning run (A3).
    const undeliveredCritical: ConditionState = { severity: 'critical', activeRuns: 1, delivered: false, lastSentAtMs: null, clearRuns: 0 }
    const first = decideConditionAction(undeliveredCritical, WARN, NOW, REMIND)
    expect(first.type).toBe('persist')
    const firstState = persistedState(first)
    expect(firstState).toMatchObject({ severity: 'warning', activeRuns: 1 })
    const second = decideConditionAction(firstState, WARN, NOW + 15 * MIN, REMIND)
    expect(second).toMatchObject({ type: 'send', kind: 'alert', transition: 'warning→warning' })
  })

  it('an UNANNOUNCED warning hardening to critical is damped one more tick (D3)', () => {
    // The counterpart of the delivered-escalation test above. Nothing has been
    // announced, so this is a first-observation critical in all but name — the
    // exact class D3 damps. Cost: one cadence (≤15 min), stated in the design.
    const dampedWarning: ConditionState = { severity: 'warning', activeRuns: 1, delivered: false, lastSentAtMs: null, clearRuns: 0 }
    const held = decideConditionAction(dampedWarning, CRIT, NOW, REMIND)
    expect(held.type).toBe('persist')
    expect(persistedState(held)).toMatchObject({ severity: 'critical', activeRuns: 1, delivered: false })
    // …and it announces on the very next tick, not later.
    const next = decideConditionAction(persistedState(held), CRIT, NOW + 15 * MIN, REMIND)
    expect(next).toMatchObject({ type: 'send', kind: 'alert', transition: 'critical→critical' })
  })

  it('recovery is DELIVERED-only and needs one full clear run (ar-M15, unchanged by D3)', () => {
    // Never-announced flap → dropped silently.
    const flap: ConditionState = { severity: 'warning', activeRuns: 1, delivered: false, lastSentAtMs: null, clearRuns: 0 }
    expect(decideConditionAction(flap, null, NOW, REMIND).type).toBe('delete-silent')
    // Delivered → first clear run only marks; the second sends RECOVERED.
    const firstClear = decideConditionAction(delivered('critical', HOUR), null, NOW, REMIND)
    expect(firstClear.type).toBe('persist')
    const marked = persistedState(firstClear)
    expect(marked.clearRuns).toBe(1)
    const secondClear = decideConditionAction(marked, null, NOW + 15 * MIN, REMIND)
    expect(secondClear).toMatchObject({ type: 'send-recovery', transition: 'critical→recovered' })
  })

  it('no state + no observation = nothing', () => {
    expect(decideConditionAction(null, null, NOW, REMIND).type).toBe('none')
  })
})
