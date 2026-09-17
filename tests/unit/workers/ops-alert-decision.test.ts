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
import { zeroWriteStreak, type ReaderRun } from '../../../server/workers/read-path-health'
import type { SourceCoverageStatus } from '../../../server/azure/dcr-metrics'

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

/*
 * A reader run at `agoMs` before NOW. `coverage` is the ingest-side verdict —
 * default 'rows-arrived' (the incident shape: the DCR received rows the joiner
 * did not land). Fixtures are PRODUCER-SHAPED (the #316 post-mortem rule): an
 * idle laptop is sessionsProcessed 1 with coverage 'no-rows', NOT sessions 0.
 */
function readerRun(
  agoMs: number,
  rowsAffected: number | null,
  status = 'success',
  coverage: SourceCoverageStatus | null = 'rows-arrived',
): ReaderRun {
  return {
    status,
    startedAtMs: NOW - agoMs,
    rowsAffected,
    sessionsProcessed: 5,
    errors: 0,
    sourceCoverage: coverage,
    newEventsSeen: 5,
  }
}

describe('decideAttributionStall (A2.2, ar-H2 — the UNIFIED streak semantic + ingest coverage)', () => {
  const STALL_MINUTES = 90

  it('pages (source-backlog) when the streak spans the window and the DCR received rows', () => {
    const runs = [readerRun(5 * MIN, 0), readerRun(35 * MIN, 0), readerRun(65 * MIN, 0), readerRun(95 * MIN, 0)]
    const v = decideAttributionStall({ runs, lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES })
    expect(v).toEqual({ since: new Date(NOW - 95 * MIN).toISOString(), zeroRuns: 4, basis: 'source-backlog' })
  })

  /*
   * THE OVERNIGHT FLAP (Dev, 2026-09-11 03:24 -> 06:39 local, ntfy count 22).
   * The probe window (15 min) is three ticks (5 min) wide, so the two runs after
   * a landing still SEE the rows that landing wrote. A streak built on those two
   * runs, followed by a quiet night, paged as a backlog and cleared on the first
   * message of the morning. Runs are 5 min apart, newest first; the run at
   * T+3 landed the last real activity; T+8 and T+13 read rows-arrived with
   * nothing left to write; everything after is no-rows.
   */
  function overnight(coverageAfter: SourceCoverageStatus = 'no-rows') {
    const runs: ReaderRun[] = []
    // 22 zero-write runs, 5 min apart: the newest at 5 min ago, the oldest at 110.
    for (let i = 0; i < 22; i += 1) {
      const ago = (5 + 5 * i) * MIN
      const isOverhang = i >= 20 // the two oldest zero runs sit inside the landing's probe window
      runs.push(readerRun(ago, 0, 'success', isOverhang ? 'rows-arrived' : coverageAfter))
    }
    runs.push(readerRun(115 * MIN, 7, 'success', 'rows-arrived')) // the landing that ended the streak
    runs.push(readerRun(120 * MIN, 0, 'success', 'no-rows'))
    return runs
  }

  it('does NOT page on the overnight replay: the rows-arrived runs sit inside the landing window', () => {
    const v = decideAttributionStall({ runs: overnight(), lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES })
    expect(v).toBeNull()
  })

  it('still pages on a real outage: rows keep arriving past the landing window and nothing lands', () => {
    const v = decideAttributionStall({ runs: overnight('rows-arrived'), lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES })
    expect(v).toMatchObject({ zeroRuns: 22, basis: 'source-backlog' })
  })

  it('still pages on a burst that arrived after the last landing and was never landed', () => {
    // Landing long ago; a burst seen 100 min ago (outside any landing window),
    // never landed, then silence. The doc keeps this in the 90-minute lane.
    const runs = [
      readerRun(5 * MIN, 0, 'success', 'no-rows'),
      readerRun(35 * MIN, 0, 'success', 'no-rows'),
      readerRun(65 * MIN, 0, 'success', 'no-rows'),
      readerRun(100 * MIN, 0, 'success', 'rows-arrived'),
      readerRun(6 * HOUR, 3, 'success', 'rows-arrived'),
    ]
    const v = decideAttributionStall({ runs, lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES })
    expect(v).toMatchObject({ zeroRuns: 4, basis: 'source-backlog' })
  })

  it('a streak ended by an unknown-outcome run keeps its evidence (an unknown is not a landing)', () => {
    const runs = [
      readerRun(5 * MIN, 0, 'success', 'no-rows'),
      readerRun(50 * MIN, 0, 'success', 'no-rows'),
      readerRun(95 * MIN, 0, 'success', 'rows-arrived'),
      readerRun(100 * MIN, null, 'failure', null), // thrown run: breaks the streak, landed nothing
      readerRun(4 * HOUR, 3, 'success', 'rows-arrived'), // the real last landing, hours before: explains nothing
    ]
    const v = decideAttributionStall({ runs, lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES })
    expect(v).toMatchObject({ zeroRuns: 3, basis: 'source-backlog' })
  })

  it('a failed run between the landing and the overhang does not hide the landing', () => {
    // Landing at T (115 min ago), a thrown run at T+5 (null ends the zero-write
    // prefix), the overhang at T+10 reading rows-arrived, then a quiet night.
    const runs: ReaderRun[] = []
    for (let i = 0; i < 21; i += 1) runs.push(readerRun((5 + 5 * i) * MIN, 0, 'success', i === 20 ? 'rows-arrived' : 'no-rows'))
    runs.push(readerRun(110 * MIN, null, 'failure', null))
    runs.push(readerRun(115 * MIN, 7, 'success', 'rows-arrived'))
    expect(zeroWriteStreak(runs)).toHaveLength(21)
    const v = decideAttributionStall({ runs, lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES })
    expect(v).toBeNull()
  })

  it('a streak that fills the loaded history treats its oldest window as undeterminable', () => {
    // The landing sits one row beyond what the loader fetched; the overhang runs
    // are the two oldest loaded rows. Not loaded is not none.
    const runs: ReaderRun[] = []
    for (let i = 0; i < 40; i += 1) runs.push(readerRun((5 + 5 * i) * MIN, 0, 'success', i >= 38 ? 'rows-arrived' : 'no-rows'))
    const v = decideAttributionStall({ runs, lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES })
    expect(v).toBeNull()
    // ...but arrivals past that oldest window are still evidence.
    const outage = runs.map((r, i) => (i < 38 ? { ...r, sourceCoverage: 'rows-arrived' as const } : r))
    expect(decideAttributionStall({ runs: outage, lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES })).toMatchObject({ basis: 'source-backlog' })
  })

  it('load ending on a failed run below the prefix with the landing unloaded does not page', () => {
    const runs: ReaderRun[] = []
    for (let i = 0; i < 38; i += 1) runs.push(readerRun((5 + 5 * i) * MIN, 0, 'success', i >= 36 ? 'rows-arrived' : 'no-rows'))
    runs.push(readerRun(195 * MIN, null, 'failure', null))
    runs.push(readerRun(200 * MIN, 0, 'success', 'rows-arrived'))
    const v = decideAttributionStall({ runs, lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES })
    expect(v).toBeNull()
  })

  it.each([
    ['inside the window (14:59 after)', 15 * MIN - 1000, null],
    ['exactly one window after (inclusive)', 15 * MIN, null],
    ['one second past the window', 15 * MIN + 1000, 'source-backlog'],
  ])('window boundary: a rows-arrived run %s the landing', (_l, afterMs, basis) => {
    const landingAgo = 120 * MIN
    const runs = [
      readerRun(5 * MIN, 0, 'success', 'no-rows'),
      readerRun(50 * MIN, 0, 'success', 'no-rows'),
      readerRun(landingAgo - afterMs, 0, 'success', 'rows-arrived'),
      readerRun(landingAgo, 6, 'success', 'rows-arrived'),
    ]
    const v = decideAttributionStall({ runs, lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES })
    if (basis === null) expect(v).toBeNull()
    else expect(v).toMatchObject({ basis })
  })

  it('a LAPTOP LEFT ON is silent — bearer fresh, session selected, coverage no-rows', () => {
    /*
     * The false positive this condition shipped with, and the reason it paged a
     * phone at 03:00 on a Sunday. THE FIXTURE IS PRODUCER-SHAPED: #307 modelled
     * this as sessionsProcessed 0 and gated on it, but the reader records
     * sessions.length — its SELECTION — so the real idle laptop is
     * sessionsProcessed 1 and walked straight through. The signal that is
     * actually empty on an idle laptop is the INGEST coverage: nothing arrived
     * at the DCR → 'no-rows'. Do not "simplify" this back to sessions 0.
     */
    const idle = [
      { status: 'success', startedAtMs: NOW - 5 * MIN, rowsAffected: 0, sessionsProcessed: 1, errors: 0, sourceCoverage: 'no-rows', newEventsSeen: 0 },
      { status: 'success', startedAtMs: NOW - 35 * MIN, rowsAffected: 0, sessionsProcessed: 1, errors: 0, sourceCoverage: 'no-rows', newEventsSeen: 0 },
      { status: 'success', startedAtMs: NOW - 95 * MIN, rowsAffected: 0, sessionsProcessed: 1, errors: 0, sourceCoverage: 'no-rows', newEventsSeen: 0 },
    ] as ReaderRun[]
    expect(
      decideAttributionStall({ runs: idle, lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES }),
    ).toBeNull()
  })

  it('still pages when the DCR received rows the joiner did not land — one run in the streak is enough', () => {
    const working = [
      { status: 'success', startedAtMs: NOW - 5 * MIN, rowsAffected: 0, sessionsProcessed: 1, errors: 0, sourceCoverage: 'no-rows', newEventsSeen: 0 },
      { status: 'success', startedAtMs: NOW - 35 * MIN, rowsAffected: 0, sessionsProcessed: 1, errors: 0, sourceCoverage: 'rows-arrived', newEventsSeen: 3 },
      { status: 'success', startedAtMs: NOW - 95 * MIN, rowsAffected: 0, sessionsProcessed: 1, errors: 0, sourceCoverage: 'no-rows', newEventsSeen: 0 },
    ] as ReaderRun[]
    expect(
      decideAttributionStall({ runs: working, lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES }),
    ).toEqual({ since: new Date(NOW - 95 * MIN).toISOString(), zeroRuns: 3, basis: 'source-backlog' })
  })

  it('coverage UNKNOWN + bearer fresh → bearer fallback (coverage-unknown-bearer-fresh)', () => {
    const runs = [readerRun(5 * MIN, 0, 'success', 'unknown'), readerRun(35 * MIN, 0, 'success', 'unknown'), readerRun(95 * MIN, 0, 'success', 'unknown')]
    expect(
      decideAttributionStall({ runs, lastFleetEmitMs: NOW - 10 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES }),
    ).toEqual({ since: new Date(NOW - 95 * MIN).toISOString(), zeroRuns: 3, basis: 'coverage-unknown-bearer-fresh' })
  })

  it('coverage UNKNOWN + bearer STALE → silent (the deploy-transition / probe-down + idle case)', () => {
    const runs = [readerRun(5 * MIN, 0, 'success', 'unknown'), readerRun(35 * MIN, 0, 'success', 'unknown'), readerRun(95 * MIN, 0, 'success', 'unknown')]
    expect(
      decideAttributionStall({ runs, lastFleetEmitMs: NOW - 3 * HOUR, nowMs: NOW, stallMinutes: STALL_MINUTES }),
    ).toBeNull()
  })

  it('coverage NO-ROWS fires nothing even with a fresh bearer (the closed false positive)', () => {
    const runs = [readerRun(5 * MIN, 0, 'success', 'no-rows'), readerRun(35 * MIN, 0, 'success', 'no-rows'), readerRun(95 * MIN, 0, 'success', 'no-rows')]
    expect(
      decideAttributionStall({ runs, lastFleetEmitMs: NOW - 1 * MIN, nowMs: NOW, stallMinutes: STALL_MINUTES }),
    ).toBeNull()
  })

  it('a real BACKLOG with a STALE bearer now pages (design §4.4: coverage is primary)', () => {
    // A burst the reader never landed, then the editor closed (bearer stale).
    // Today this was silent; coverage 'rows-arrived' makes it a real stall.
    const runs = [readerRun(5 * MIN, 0, 'success', 'rows-arrived'), readerRun(35 * MIN, 0, 'success', 'rows-arrived'), readerRun(95 * MIN, 0, 'success', 'rows-arrived')]
    expect(
      decideAttributionStall({ runs, lastFleetEmitMs: NOW - 3 * HOUR, nowMs: NOW, stallMinutes: STALL_MINUTES }),
    ).toEqual({ since: new Date(NOW - 95 * MIN).toISOString(), zeroRuns: 3, basis: 'source-backlog' })
  })

  it('a row-writing run breaks the streak; a streak narrower than the window withholds', () => {
    expect(
      decideAttributionStall({
        runs: [readerRun(5 * MIN, 0), readerRun(20 * MIN, 42), readerRun(95 * MIN, 0)],
        lastFleetEmitMs: NOW - 10 * MIN,
        nowMs: NOW,
        stallMinutes: STALL_MINUTES,
      }),
    ).toBeNull()
    expect(
      decideAttributionStall({
        runs: [readerRun(5 * MIN, 0), readerRun(20 * MIN, 0)],
        lastFleetEmitMs: NOW - 10 * MIN,
        nowMs: NOW,
        stallMinutes: STALL_MINUTES,
      }),
    ).toBeNull()
  })

  it('a FAILED zero-row run does NOT break the streak (unified semantic, A2.2)', () => {
    const v = decideAttributionStall({
      runs: [readerRun(5 * MIN, 0, 'failure'), readerRun(35 * MIN, 0), readerRun(95 * MIN, 0)],
      lastFleetEmitMs: NOW - 10 * MIN,
      nowMs: NOW,
      stallMinutes: STALL_MINUTES,
    })
    expect(v).toEqual({ since: new Date(NOW - 95 * MIN).toISOString(), zeroRuns: 3, basis: 'source-backlog' })
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
