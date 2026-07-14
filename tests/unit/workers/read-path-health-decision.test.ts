/*
 * decideReadPathAlert — the PURE trigger-decision logic for the read-path-health
 * worker, tested independent of the DB (mirrors the pure-unit style of
 * analytics-poll-window.test.ts).
 *
 * The worker turns a SILENT OTel read-path outage (the azure-monitor-read
 * gatherer dead while clients still emit — the 5.5-day incident) into an admin
 * inbox alert. This file pins WHEN it fires and WHICH reason, given the
 * already-persisted worker_run rows + last-seen FLEET-EMIT freshness + a clock.
 *
 * CRITICAL invariant (the HIGH this alert exists to catch): the "is the fleet
 * still emitting?" gate is measured with an INDEPENDENT write/emit-auth signal
 * (MAX instance_attestation.last_bearer_at — bearer mints), NOT the read path's
 * own output. So a SUSTAINED silent-zero-write outage keeps firing STALL for its
 * whole duration and never falsely auto-resolves. See the "HIGH regression" test.
 *
 * Reasons (precedence: all-fault > stall > no-success):
 *   - all-fault:  the LATEST run errored on >= 2 sessions it processed.
 *   - stall:      the last N runs ALL wrote 0 rows while the fleet is still emitting.
 *   - no-success: no successful run in the recent window (covers a throwing reader).
 */
import { describe, it, expect } from 'vitest'
import {
  decideReadPathAlert,
  type ReaderRun,
  type DecideInput,
} from '../../../server/workers/read-path-health'

const NOW = new Date('2026-06-20T12:00:00Z').getTime()
const MIN = 60 * 1000
const HOUR = 60 * MIN

// A successful run that wrote `rows` rows, `agoMs` before NOW.
function successRun(rows: number, agoMs: number, sessionsProcessed = 5, errors = 0): ReaderRun {
  return { status: 'success', startedAtMs: NOW - agoMs, rowsAffected: rows, sessionsProcessed, errors }
}

function base(overrides: Partial<DecideInput>): DecideInput {
  return {
    runs: [],
    lastFleetEmitMs: NOW - 5 * MIN, // fleet minting bearers recently by default
    nowMs: NOW,
    ...overrides,
  }
}

describe('decideReadPathAlert — healthy', () => {
  it('does NOT fire when recent runs are writing rows', () => {
    const runs = [successRun(12, 2 * MIN), successRun(8, 17 * MIN), successRun(20, 32 * MIN)]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })

  it('does NOT fire on an empty ledger (fresh deploy, no runs yet) — unknown, not outage', () => {
    expect(decideReadPathAlert(base({ runs: [] }))).toEqual({ fire: false, reason: null })
  })

  it('does NOT fire on a clean 0-session tick (nothing to do, no error)', () => {
    // A genuinely IDLE fleet: no bearer mints in 6h → fleet not emitting → zero-write
    // successes are correct (nothing to land), not a stall.
    const runs = [successRun(0, 2 * MIN, 0, 0), successRun(0, 17 * MIN, 0, 0), successRun(0, 32 * MIN, 0, 0)]
    const input = base({ runs, lastFleetEmitMs: NOW - 6 * HOUR })
    expect(decideReadPathAlert(input)).toEqual({ fire: false, reason: null })
  })
})

describe('decideReadPathAlert — STALL (reader dead but fleet still emitting)', () => {
  it('fires stall: last 3 runs all wrote 0 rows WHILE the fleet is still minting bearers', () => {
    // The exact incident shape: sessions ARE being scanned (5 each) but 0 rows land.
    const runs = [
      successRun(0, 2 * MIN, 5, 0),
      successRun(0, 17 * MIN, 5, 0),
      successRun(0, 32 * MIN, 5, 0),
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: true, reason: 'stall' })
  })

  it('HIGH regression: a SUSTAINED zero-write outage keeps firing (does NOT auto-resolve mid-outage)', () => {
    // The bug the ts_event gate had: after ~2h of silent zero-write SUCCESS runs,
    // reader-written usage aged out → gate dropped → fire:false → false recovery.
    // With the bearer-mint gate the fleet is STILL minting (bearers are a ~29-min
    // heartbeat), so even though the OLDEST successful run is >2h old and the
    // ledger has been all-zero for hours, STALL stays ARMED.
    const runs = [
      successRun(0, 5 * MIN, 5, 0),
      successRun(0, 20 * MIN, 5, 0),
      successRun(0, 35 * MIN, 5, 0),
      successRun(0, 3 * HOUR, 5, 0), // outage has been running for hours
    ]
    // Fleet still emitting (bearer 10 min ago) — reader output is irrelevant here.
    const input = base({ runs, lastFleetEmitMs: NOW - 10 * MIN })
    expect(decideReadPathAlert(input)).toEqual({ fire: true, reason: 'stall' })
  })

  it('recovery: the alert stops (fire:false) ONLY when rows actually start landing again', () => {
    // Same sustained outage, but the freshest run finally wrote rows → the
    // zero-write streak breaks → healthy → runReadPathHealth will auto-resolve.
    const runs = [
      successRun(17, 2 * MIN, 5, 0), // rows landing again
      successRun(0, 20 * MIN, 5, 0),
      successRun(0, 35 * MIN, 5, 0),
    ]
    const input = base({ runs, lastFleetEmitMs: NOW - 10 * MIN })
    expect(decideReadPathAlert(input)).toEqual({ fire: false, reason: null })
  })

  it('does NOT fire stall when the fleet is genuinely IDLE (no bearer mints in >2h)', () => {
    const runs = [successRun(0, 2 * MIN, 5), successRun(0, 17 * MIN, 5), successRun(0, 32 * MIN, 5)]
    const input = base({ runs, lastFleetEmitMs: NOW - 3 * HOUR })
    expect(decideReadPathAlert(input)).toEqual({ fire: false, reason: null })
  })

  it('does NOT fire stall when the fleet has NEVER minted (lastFleetEmitMs null)', () => {
    const runs = [successRun(0, 2 * MIN, 5), successRun(0, 17 * MIN, 5), successRun(0, 32 * MIN, 5)]
    const input = base({ runs, lastFleetEmitMs: null })
    expect(decideReadPathAlert(input)).toEqual({ fire: false, reason: null })
  })

  it('does NOT fire stall with only 2 zero-write runs (needs >=3)', () => {
    const runs = [successRun(0, 2 * MIN, 5), successRun(0, 17 * MIN, 5), successRun(7, 32 * MIN, 5)]
    // Latest two are zero, third wrote rows → streak broken at 3 → no stall.
    // (No no-success trigger: there IS a recent success within 30 min.)
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })

  it('does NOT fire stall when the freshest of the 3 wrote rows (recovered)', () => {
    const runs = [successRun(9, 2 * MIN, 5), successRun(0, 17 * MIN, 5), successRun(0, 32 * MIN, 5)]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })

  it('a null rows_affected in the top-3 breaks the zero-streak (unknown != zero)', () => {
    const runs: ReaderRun[] = [
      { status: 'success', startedAtMs: NOW - 2 * MIN, rowsAffected: null, sessionsProcessed: 5, errors: 0 },
      successRun(0, 17 * MIN, 5),
      successRun(0, 32 * MIN, 5),
    ]
    // top-3 not ALL zero (one is null) → no stall. Recent success exists → no no-success.
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })

  it('fleet-emit freshness is inclusive at exactly the 2h boundary', () => {
    const runs = [successRun(0, 2 * MIN, 5), successRun(0, 17 * MIN, 5), successRun(0, 32 * MIN, 5)]
    const input = base({ runs, lastFleetEmitMs: NOW - 2 * HOUR }) // exactly 2h → still fresh (<=)
    expect(decideReadPathAlert(input)).toEqual({ fire: true, reason: 'stall' })
  })
})

describe('decideReadPathAlert — ALL-FAULT (latest run errored on every session)', () => {
  it('fires all-fault: errors == sessionsProcessed (>= floor) on the latest run', () => {
    const runs: ReaderRun[] = [
      { status: 'success', startedAtMs: NOW - 2 * MIN, rowsAffected: 0, sessionsProcessed: 4, errors: 4 },
      successRun(10, 17 * MIN, 5),
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: true, reason: 'all-fault' })
  })

  it('fires all-fault: errors > sessionsProcessed (defensive >=) on the latest run', () => {
    const runs: ReaderRun[] = [
      { status: 'success', startedAtMs: NOW - 2 * MIN, rowsAffected: 0, sessionsProcessed: 3, errors: 5 },
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: true, reason: 'all-fault' })
  })

  it('LOW: does NOT fire all-fault on a single flaky session (sessionsProcessed 1, errors 1)', () => {
    // One transient ING-6-isolated session must NOT page platform-admins urgent.
    // The freshest run wrote rows so no stall; a recent success so no no-success.
    const runs: ReaderRun[] = [
      { status: 'success', startedAtMs: NOW - 2 * MIN, rowsAffected: 3, sessionsProcessed: 1, errors: 1 },
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })

  it('fires all-fault at the floor exactly (sessionsProcessed 2, errors 2)', () => {
    const runs: ReaderRun[] = [
      { status: 'success', startedAtMs: NOW - 2 * MIN, rowsAffected: 0, sessionsProcessed: 2, errors: 2 },
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: true, reason: 'all-fault' })
  })

  it('does NOT fire all-fault when sessionsProcessed is 0 (clean idle tick)', () => {
    const runs: ReaderRun[] = [
      { status: 'success', startedAtMs: NOW - 2 * MIN, rowsAffected: 0, sessionsProcessed: 0, errors: 0 },
      successRun(9, 17 * MIN, 5),
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })

  it('does NOT fire all-fault on PARTIAL errors (errors < sessionsProcessed)', () => {
    const runs: ReaderRun[] = [
      { status: 'success', startedAtMs: NOW - 2 * MIN, rowsAffected: 3, sessionsProcessed: 5, errors: 2 },
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })

  it('all-fault takes precedence over stall when both would trip', () => {
    // Latest run: all sessions errored (all-fault) AND the top-3 all wrote 0 (stall).
    const runs: ReaderRun[] = [
      { status: 'success', startedAtMs: NOW - 2 * MIN, rowsAffected: 0, sessionsProcessed: 5, errors: 5 },
      successRun(0, 17 * MIN, 5),
      successRun(0, 32 * MIN, 5),
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: true, reason: 'all-fault' })
  })
})

describe('decideReadPathAlert — NO-SUCCESS (no recent successful run; covers a throwing reader)', () => {
  it('fires no-success: newest success is older than 30 min and no stall/all-fault applies', () => {
    // Two THROWN failures on top (status=failure, rows null → no stall; result absent
    // → sessionsProcessed/errors null → no all-fault). Last success 40 min ago.
    // This is exactly the throwing-reader case NO-SUCCESS is meant to cover.
    const runs: ReaderRun[] = [
      { status: 'failure', startedAtMs: NOW - 2 * MIN, rowsAffected: null, sessionsProcessed: null, errors: null },
      { status: 'failure', startedAtMs: NOW - 17 * MIN, rowsAffected: null, sessionsProcessed: null, errors: null },
      successRun(10, 40 * MIN, 5),
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: true, reason: 'no-success' })
  })

  it('does NOT fire no-success when a success is within 30 min', () => {
    const runs: ReaderRun[] = [
      { status: 'failure', startedAtMs: NOW - 2 * MIN, rowsAffected: null, sessionsProcessed: null, errors: null },
      successRun(10, 20 * MIN, 5),
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })

  it('fires no-success when EVERY run in the ledger is a (thrown) failure', () => {
    const runs: ReaderRun[] = [
      { status: 'failure', startedAtMs: NOW - 2 * MIN, rowsAffected: null, sessionsProcessed: null, errors: null },
      { status: 'failure', startedAtMs: NOW - 17 * MIN, rowsAffected: null, sessionsProcessed: null, errors: null },
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: true, reason: 'no-success' })
  })
})
