/*
 * decideReadPathAlert — the PURE trigger-decision logic for the read-path-health
 * worker, tested independent of the DB (mirrors analytics-poll-window.test.ts).
 *
 * The worker turns a SILENT OTel read-path outage (the azure-monitor-read
 * gatherer dead while clients still emit — the 5.5-day incident) into an admin
 * inbox alert. This file pins WHEN it fires and WHICH reason.
 *
 * THE STALL GATE IS THE INGEST-SIDE COVERAGE VERDICT (PR #319), not the reader's
 * own output. Fixtures are PRODUCER-SHAPED: an idle open editor is the DCR
 * coverage 'no-rows' (nothing arrived) with a FRESH bearer and a selected
 * session — NOT a zero-session tick. A real outage is coverage 'rows-arrived'
 * (the pipeline received rows the joiner did not land). A probe that could not
 * measure is 'unknown' → the bearer fallback. This is what closes both the false
 * positive (#307/idle-laptop) and the false negative (#316/reader-derived gate).
 *
 * CRITICAL invariant: a SUSTAINED outage keeps firing (coverage stays
 * 'rows-arrived' as rows keep arriving) and never falsely auto-resolves — and the
 * streak is the FULL consecutive zero-write run, not a top-3 slice, so evidence
 * cannot age out of one window (external review of #316, findings 7/10).
 *
 * Reasons (precedence: all-fault > stall > no-success).
 */
import { describe, it, expect } from 'vitest'
import {
  decideReadPathAlert,
  hasWorkEvidenceCoverage,
  zeroWriteStreak,
  streakSourceCoverage,
  lastLandingBeforeStreak,
  type ReaderRun,
  type DecideInput,
} from '../../../server/workers/read-path-health'
import type { SourceCoverageStatus } from '../../../server/azure/dcr-metrics'

const NOW = new Date('2026-06-20T12:00:00Z').getTime()
const MIN = 60 * 1000
const HOUR = 60 * MIN

/*
 * A successful run that wrote `rows` rows, `agoMs` before NOW. `coverage` is the
 * ingest-side verdict for that tick — default 'rows-arrived' (the outage shape:
 * the DCR received rows the joiner did not land). Pass 'no-rows' for an idle
 * estate, 'unknown' for a run whose probe could not measure, null for a run
 * recorded before the probe shipped. newEventsSeen is a diagnostic (not gated on).
 */
function run(
  rows: number | null,
  agoMs: number,
  coverage: SourceCoverageStatus | null = 'rows-arrived',
  opts: { status?: string; sessionsProcessed?: number | null; errors?: number | null; newEventsSeen?: number | null } = {},
): ReaderRun {
  return {
    status: opts.status ?? 'success',
    startedAtMs: NOW - agoMs,
    rowsAffected: rows,
    sessionsProcessed: opts.sessionsProcessed ?? 5,
    errors: opts.errors ?? 0,
    sourceCoverage: coverage,
    newEventsSeen: opts.newEventsSeen ?? 5,
  }
}

function base(overrides: Partial<DecideInput>): DecideInput {
  return {
    runs: [],
    lastFleetEmitMs: NOW - 5 * MIN, // fleet minting bearers recently by default
    nowMs: NOW,
    ...overrides,
  }
}

describe('zeroWriteStreak / streakSourceCoverage — the shared streak + coverage helpers', () => {
  it('zeroWriteStreak takes the consecutive top zero-write runs; a >0 or null ends it', () => {
    expect(zeroWriteStreak([run(0, MIN), run(0, 2 * MIN), run(7, 3 * MIN)]).length).toBe(2)
    expect(zeroWriteStreak([run(null, MIN), run(0, 2 * MIN)]).length).toBe(0)
    expect(zeroWriteStreak([run(0, MIN), run(0, 2 * MIN), run(0, 3 * MIN)]).length).toBe(3)
  })

  // A landing far older than the probe window: it explains nothing, so these
  // exercise precedence alone.
  const OLD_LANDING = NOW - 4 * HOUR

  it('streakSourceCoverage: rows-arrived wins over no-rows wins over unknown', () => {
    expect(streakSourceCoverage([run(0, MIN, 'no-rows'), run(0, 2 * MIN, 'rows-arrived')], OLD_LANDING)).toBe('rows-arrived')
    expect(streakSourceCoverage([run(0, MIN, 'no-rows'), run(0, 2 * MIN, null)], OLD_LANDING)).toBe('no-rows')
    expect(streakSourceCoverage([run(0, MIN, null), run(0, 2 * MIN, null)], OLD_LANDING)).toBe('unknown')
    expect(streakSourceCoverage([], OLD_LANDING)).toBe('unknown')
  })

  it('with no loaded landing, the oldest probe window of the streak is not evidence', () => {
    // Nothing below the streak was loaded: the run(s) inside one window of the
    // oldest are undeterminable (explained -> quiet); a later sample still counts.
    expect(streakSourceCoverage([run(0, MIN, 'rows-arrived')])).toBe('no-rows')
    expect(streakSourceCoverage([run(0, MIN, 'rows-arrived'), run(0, 30 * MIN, 'no-rows')])).toBe('rows-arrived')
    expect(streakSourceCoverage([run(0, MIN, 'no-rows'), run(0, 30 * MIN, 'rows-arrived')])).toBe('no-rows')
  })

  it('hasWorkEvidenceCoverage is true only for a rows-arrived streak', () => {
    expect(hasWorkEvidenceCoverage([run(0, MIN, 'rows-arrived')], OLD_LANDING)).toBe(true)
    expect(hasWorkEvidenceCoverage([run(0, MIN, 'no-rows')], OLD_LANDING)).toBe(false)
    expect(hasWorkEvidenceCoverage([run(0, MIN, null)], OLD_LANDING)).toBe(false)
  })
})

describe('STALL work evidence must postdate the last landing (the overnight flap)', () => {
  // 5-min ticks, newest first. The landing at 115 min ago wrote 7 rows; the two
  // zero runs inside its 15-min probe window read rows-arrived with nothing to
  // write; the rest of the night is no-rows.
  function overnight(coverageAfter: SourceCoverageStatus = 'no-rows'): ReaderRun[] {
    const runs: ReaderRun[] = []
    for (let i = 0; i < 22; i += 1) runs.push(run(0, (5 + 5 * i) * MIN, i >= 20 ? 'rows-arrived' : coverageAfter))
    runs.push(run(7, 115 * MIN, 'rows-arrived'))
    runs.push(run(0, 120 * MIN, 'no-rows'))
    return runs
  }

  it('does not fire on the overnight replay', () => {
    expect(decideReadPathAlert(base({ runs: overnight() }))).toEqual({ fire: false, reason: null })
  })

  it('fires when rows keep arriving past the landing window', () => {
    expect(decideReadPathAlert(base({ runs: overnight('rows-arrived') }))).toEqual({
      fire: true,
      reason: 'stall',
      coverageBasis: 'source-backlog',
    })
  })

  it('a streak of nothing but explained samples is quiet, not unknown (no bearer fallback)', () => {
    // The inbox item's minimum streak (3 zero runs), all inside the landing's
    // window and all reading rows-arrived. Every sample is explained; the fleet
    // is minting. Before: coverage 'unknown' -> bearer fallback -> fired.
    const runs = [run(0, 5 * MIN), run(0, 10 * MIN), run(0, 15 * MIN), run(6, 18 * MIN)]
    expect(streakSourceCoverage(zeroWriteStreak(runs), lastLandingBeforeStreak(runs, zeroWriteStreak(runs)))).toBe('no-rows')
    expect(decideReadPathAlert(base({ runs, lastFleetEmitMs: NOW - 2 * MIN }))).toEqual({ fire: false, reason: null })
    // Genuinely unmeasured stays unknown (and the bearer fallback applies).
    const unmeasured = [run(0, 5 * MIN, null), run(0, 10 * MIN, null), run(0, 15 * MIN, null), run(6, 18 * MIN)]
    expect(streakSourceCoverage(zeroWriteStreak(unmeasured), NOW - 18 * MIN)).toBe('unknown')
  })

  it('lastLandingBeforeStreak: the nearest landing below the streak, past unknown and zero runs', () => {
    const landed = [run(0, 5 * MIN), run(0, 10 * MIN), run(4, 15 * MIN)]
    expect(lastLandingBeforeStreak(landed, zeroWriteStreak(landed))).toBe(NOW - 15 * MIN)
    // A thrown run ends the streak but is not a landing; the landing below it still counts.
    const pastFailure = [run(0, 5 * MIN), run(null, 10 * MIN, null, { status: 'failure' }), run(0, 15 * MIN), run(4, 20 * MIN)]
    expect(lastLandingBeforeStreak(pastFailure, zeroWriteStreak(pastFailure))).toBe(NOW - 20 * MIN)
    const noLanding = [run(0, 5 * MIN), run(0, 10 * MIN)]
    expect(lastLandingBeforeStreak(noLanding, zeroWriteStreak(noLanding))).toBeNull()
  })

  it('load ending on a failed run below the prefix, landing unloaded: oldest window is not evidence', () => {
    // 20-row cap: 18 zero runs, a failed run (ends the prefix), one more zero run —
    // the landing is the 21st row and was not loaded. streak.length !== runs.length.
    const runs: ReaderRun[] = []
    for (let i = 0; i < 18; i += 1) runs.push(run(0, (5 + 5 * i) * MIN, i >= 16 ? 'rows-arrived' : 'no-rows'))
    runs.push(run(null, 95 * MIN, null, { status: 'failure' }))
    runs.push(run(0, 100 * MIN, 'rows-arrived'))
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })

  it('a streak filling the loaded history (landing not loaded): oldest window is not evidence', () => {
    const runs: ReaderRun[] = []
    for (let i = 0; i < 20; i += 1) runs.push(run(0, (5 + 5 * i) * MIN, i >= 18 ? 'rows-arrived' : 'no-rows'))
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })
})

describe('decideReadPathAlert — healthy', () => {
  it('does NOT fire when recent runs are writing rows', () => {
    const runs = [run(12, 2 * MIN), run(8, 17 * MIN), run(20, 32 * MIN)]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })

  it('does NOT fire on an empty ledger (fresh deploy, no runs yet)', () => {
    expect(decideReadPathAlert(base({ runs: [] }))).toEqual({ fire: false, reason: null })
  })
})

describe('decideReadPathAlert — STALL', () => {
  it('fires stall: a zero-write streak WHILE the DCR received rows (coverage rows-arrived)', () => {
    // The exact incident shape — the pipeline received rows every tick, none landed.
    const runs = [run(0, 2 * MIN, 'rows-arrived'), run(0, 17 * MIN, 'rows-arrived'), run(0, 32 * MIN, 'rows-arrived')]
    expect(decideReadPathAlert(base({ runs }))).toEqual({
      fire: true,
      reason: 'stall',
      coverageBasis: 'source-backlog',
    })
  })

  it('REGRESSION (case A): idle open editor — bearer FRESH, session selected, coverage no-rows — does NOT fire', () => {
    /*
     * The false positive #307/#316 could not close. The editor is open (bearer
     * minted 5 min ago, a session selected → sessionsProcessed 1) but NOTHING
     * arrived at the DCR — coverage 'no-rows'. read-path-stale fired 7×/24h on
     * exactly this. Fires only if the coverage gate is removed (mutation proof).
     */
    const idle = [
      run(0, 2 * MIN, 'no-rows', { sessionsProcessed: 1, newEventsSeen: 0 }),
      run(0, 17 * MIN, 'no-rows', { sessionsProcessed: 1, newEventsSeen: 0 }),
      run(0, 32 * MIN, 'no-rows', { sessionsProcessed: 1, newEventsSeen: 0 }),
    ]
    expect(decideReadPathAlert(base({ runs: idle }))).toEqual({ fire: false, reason: null })
  })

  it('a STUCK reader — same laptop, but one run in the streak saw rows arrive — fires', () => {
    // Coverage over the streak is rows-arrived (one tick received rows), so the
    // whole streak is a backlog even though later probes read empty.
    const stuck = [
      run(0, 2 * MIN, 'no-rows', { sessionsProcessed: 1, newEventsSeen: 0 }),
      run(0, 17 * MIN, 'rows-arrived', { sessionsProcessed: 1 }),
      run(0, 32 * MIN, 'no-rows', { sessionsProcessed: 1, newEventsSeen: 0 }),
      run(9, 4 * HOUR, 'rows-arrived'), // the last landing, long before the burst: it explains nothing
    ]
    expect(decideReadPathAlert(base({ runs: stuck }))).toEqual({
      fire: true,
      reason: 'stall',
      coverageBasis: 'source-backlog',
    })
  })

  it('coverage UNKNOWN + bearer FRESH → fires on the bearer FALLBACK (fails toward paging)', () => {
    // The probe could not measure (403 / pre-deploy / probe fault). We fall back
    // to today's bearer gate: fresh mints → page, named so the operator sees why.
    const runs = [run(0, 2 * MIN, 'unknown'), run(0, 17 * MIN, 'unknown'), run(0, 32 * MIN, 'unknown')]
    expect(decideReadPathAlert(base({ runs, lastFleetEmitMs: NOW - 10 * MIN }))).toEqual({
      fire: true,
      reason: 'stall',
      coverageBasis: 'coverage-unknown-bearer-fresh',
    })
  })

  it('coverage UNKNOWN + bearer STALE → does NOT fire (nothing says there is work)', () => {
    const runs = [run(0, 2 * MIN, 'unknown'), run(0, 17 * MIN, 'unknown'), run(0, 32 * MIN, 'unknown')]
    expect(decideReadPathAlert(base({ runs, lastFleetEmitMs: NOW - 3 * HOUR }))).toEqual({
      fire: false,
      reason: null,
    })
  })

  it('coverage NO-ROWS never fires, even with a fresh bearer', () => {
    const runs = [run(0, 2 * MIN, 'no-rows'), run(0, 17 * MIN, 'no-rows'), run(0, 32 * MIN, 'no-rows')]
    expect(decideReadPathAlert(base({ runs, lastFleetEmitMs: NOW - 1 * MIN }))).toEqual({
      fire: false,
      reason: null,
    })
  })

  it('DEPLOY TRANSITION: a streak of pre-probe runs (coverage null) + bearer fresh → bearer fallback fires', () => {
    // Before the probe ships, every run's coverage is null → unknown → the
    // decision is exactly main's: bearer fresh + zero-write streak → page.
    const preDeploy = [run(0, 2 * MIN, null), run(0, 17 * MIN, null), run(0, 32 * MIN, null)]
    expect(decideReadPathAlert(base({ runs: preDeploy, lastFleetEmitMs: NOW - 10 * MIN }))).toEqual({
      fire: true,
      reason: 'stall',
      coverageBasis: 'coverage-unknown-bearer-fresh',
    })
    // Once one new-probe run enters the streak with rows-arrived, basis upgrades.
    const mixed = [run(0, 2 * MIN, 'rows-arrived'), run(0, 17 * MIN, null), run(0, 32 * MIN, null)]
    expect(decideReadPathAlert(base({ runs: mixed }))).toEqual({
      fire: true,
      reason: 'stall',
      coverageBasis: 'source-backlog',
    })
  })

  it('HIGH regression: a SUSTAINED outage keeps firing (does NOT auto-resolve mid-outage)', () => {
    // The FULL streak is evaluated, not a top-3 slice: even a run 3h deep in the
    // streak that saw rows arrive keeps STALL armed. Rows keep arriving during a
    // real outage, so coverage stays rows-arrived and the alert never auto-resolves.
    const runs = [
      run(0, 5 * MIN, 'no-rows', { newEventsSeen: 0 }), // recent probes read empty
      run(0, 20 * MIN, 'no-rows', { newEventsSeen: 0 }),
      run(0, 35 * MIN, 'no-rows', { newEventsSeen: 0 }),
      run(0, 3 * HOUR, 'rows-arrived'), // the burst that started the outage, deep in the streak
      run(9, 5 * HOUR, 'rows-arrived'), // the last landing, two hours before the burst
    ]
    expect(decideReadPathAlert(base({ runs, lastFleetEmitMs: NOW - 3 * HOUR }))).toEqual({
      fire: true,
      reason: 'stall',
      coverageBasis: 'source-backlog',
    })
  })

  it('recovery: the alert stops ONLY when rows actually start landing again', () => {
    // The freshest run wrote rows → the zero-write streak breaks → healthy.
    const runs = [run(17, 2 * MIN, 'rows-arrived'), run(0, 20 * MIN, 'rows-arrived'), run(0, 35 * MIN, 'rows-arrived')]
    expect(decideReadPathAlert(base({ runs, lastFleetEmitMs: NOW - 10 * MIN }))).toEqual({ fire: false, reason: null })
  })

  it('does NOT fire with only 2 zero-write runs (needs >=3), even coverage rows-arrived', () => {
    const runs = [run(0, 2 * MIN, 'rows-arrived'), run(0, 17 * MIN, 'rows-arrived'), run(7, 32 * MIN)]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })

  it('a null rows_affected at the top breaks the zero-streak (unknown != zero)', () => {
    const runs = [run(null, 2 * MIN, 'rows-arrived'), run(0, 17 * MIN, 'rows-arrived'), run(0, 32 * MIN, 'rows-arrived')]
    // streak length 0 → no stall; a recent success exists → no no-success.
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })
})

describe('decideReadPathAlert — ALL-FAULT (unchanged: covers the errored-every-session run)', () => {
  it('fires all-fault: errors == sessionsProcessed (>= floor) on the latest run', () => {
    const runs = [run(0, 2 * MIN, 'rows-arrived', { sessionsProcessed: 4, errors: 4 }), run(10, 17 * MIN)]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: true, reason: 'all-fault' })
  })

  it('LOW: does NOT fire all-fault on a single flaky session', () => {
    const runs = [run(3, 2 * MIN, 'rows-arrived', { sessionsProcessed: 1, errors: 1 })]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })

  it('all-fault takes precedence over stall when both would trip', () => {
    const runs = [
      run(0, 2 * MIN, 'rows-arrived', { sessionsProcessed: 5, errors: 5 }),
      run(0, 17 * MIN, 'rows-arrived'),
      run(0, 32 * MIN, 'rows-arrived'),
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: true, reason: 'all-fault' })
  })
})

describe('decideReadPathAlert — NO-SUCCESS (unchanged: covers a throwing reader)', () => {
  it('fires no-success: newest success older than 30 min, thrown failures on top', () => {
    const runs: ReaderRun[] = [
      { status: 'failure', startedAtMs: NOW - 2 * MIN, rowsAffected: null, sessionsProcessed: null, errors: null, sourceCoverage: null, newEventsSeen: null },
      { status: 'failure', startedAtMs: NOW - 17 * MIN, rowsAffected: null, sessionsProcessed: null, errors: null, sourceCoverage: null, newEventsSeen: null },
      run(10, 40 * MIN),
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: true, reason: 'no-success' })
  })

  it('does NOT fire no-success when a success is within 30 min', () => {
    const runs: ReaderRun[] = [
      { status: 'failure', startedAtMs: NOW - 2 * MIN, rowsAffected: null, sessionsProcessed: null, errors: null, sourceCoverage: null, newEventsSeen: null },
      run(10, 20 * MIN),
    ]
    expect(decideReadPathAlert(base({ runs }))).toEqual({ fire: false, reason: null })
  })
})
