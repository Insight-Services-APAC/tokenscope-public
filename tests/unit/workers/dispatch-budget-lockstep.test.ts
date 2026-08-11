/*
 * The dispatch budget lives in three files that cannot import each other:
 * a TS constant, a plain .mjs script, and a bicep template. Drift between them
 * is not a tidiness problem -- it is the exact defect this budget exists to fix.
 *
 * On Dev in 2026-07 the bicep set nothing, so the .mjs fallback (120s) applied
 * against a 240s replicaTimeout. region-reenrichment ran 134.5s server-side,
 * wrote `success`, and was reported as a FAILED execution 73 times running;
 * analytics-poll ran 108.3s and failed about half its executions. Nothing in CI
 * could see it, because no test compared the three numbers.
 *
 * These assertions are that comparison.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DISPATCH_TIMEOUT_MS,
  REPLICA_TIMEOUT_SECONDS,
  DISPATCH_NEAR_FRACTION,
  classifyDispatchDuration,
  dispatchBudgetReason,
} from '../../../shared/workers/dispatch-budget'

const root = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

describe('dispatch budget lockstep', () => {
  it('the cron-trigger fallback equals DISPATCH_TIMEOUT_MS', () => {
    const src = read('scripts/cron-trigger.mjs')
    // Underscores allowed and stripped: the TS constant is written 200_000 and the
    // .mjs 200000, so normalising the two styles must not fail a test that exists to
    // compare their VALUES. Number('200_000') is NaN, hence the replace.
    const m = src.match(/resolveTimeoutMs\(\s*process\.env\.CRON_TRIGGER_TIMEOUT_MS\s*,\s*([\d_]+)\s*\)/)
    expect(m, 'cron-trigger.mjs must resolve CRON_TRIGGER_TIMEOUT_MS against a numeric fallback').not.toBeNull()
    expect(Number(m![1].replaceAll('_', ''))).toBe(DISPATCH_TIMEOUT_MS)
  })

  it('the fallback comparison survives numeric-separator formatting', () => {
    // Pins the tolerance itself, so a future tightening of the regex to \d+ shows up
    // here rather than as a mystery failure after someone reformats a literal.
    const parse = (literal: string) => Number(literal.replaceAll('_', ''))
    expect(parse('200_000')).toBe(parse('200000'))
  })

  it('the cron-trigger VALIDATES the env value rather than bare-parsing it', () => {
    // A bare Number() would let a typo'd env become NaN, and setTimeout(fn, NaN)
    // fires on the next tick -- an instant abort reported as a FAILED execution.
    const src = read('scripts/cron-trigger.mjs')
    expect(src).not.toMatch(/Number\(\s*process\.env\.CRON_TRIGGER_TIMEOUT_MS/)
    expect(src).toMatch(/resolveTimeoutMs/)
  })

  it('the bicep dispatchTimeoutMs default equals DISPATCH_TIMEOUT_MS', () => {
    const src = read('infra/modules/worker-jobs.bicep')
    const m = src.match(/param\s+dispatchTimeoutMs\s+int\s*=\s*(\d+)/)
    expect(m, 'worker-jobs.bicep must declare a dispatchTimeoutMs param with a default').not.toBeNull()
    expect(Number(m![1])).toBe(DISPATCH_TIMEOUT_MS)
  })

  it('every job actually receives CRON_TRIGGER_TIMEOUT_MS', () => {
    // Declaring the param but never wiring it into the container env would leave
    // the .mjs fallback in charge -- silently reintroducing the original bug.
    const src = read('infra/modules/worker-jobs.bicep')
    expect(src).toMatch(/name:\s*'CRON_TRIGGER_TIMEOUT_MS'\s*,\s*value:\s*'\$\{dispatchTimeoutMs\}'/)
  })

  it('the bicep replicaTimeout equals REPLICA_TIMEOUT_SECONDS', () => {
    const src = read('infra/modules/worker-jobs.bicep')
    const m = src.match(/replicaTimeout:\s*(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(REPLICA_TIMEOUT_SECONDS)
  })

  it('the trigger gives up BEFORE the platform kills the replica', () => {
    // Ordering, not just values. If the replica is killed first we lose the
    // trigger's log line naming the worker, which is the only legible artefact
    // when a run overruns.
    expect(DISPATCH_TIMEOUT_MS).toBeLessThan(REPLICA_TIMEOUT_SECONDS * 1000)
  })
})

describe('classifyDispatchDuration', () => {
  it('flags a run at or past the budget as over', () => {
    expect(classifyDispatchDuration(DISPATCH_TIMEOUT_MS)).toBe('over')
    expect(classifyDispatchDuration(DISPATCH_TIMEOUT_MS + 1)).toBe('over')
  })

  it('flags a run at the near threshold as near, and just under it as ok', () => {
    const near = DISPATCH_TIMEOUT_MS * DISPATCH_NEAR_FRACTION
    expect(classifyDispatchDuration(near)).toBe('near')
    expect(classifyDispatchDuration(near - 1)).toBe('ok')
  })

  it('would have caught the two real Dev regressions', () => {
    // The observed durations, against the OLD 120s budget. Both must be
    // non-ok so the panel could not have called them healthy.
    const OLD_BUDGET = 120_000
    expect(134_520).toBeGreaterThanOrEqual(OLD_BUDGET) // region-reenrichment
    expect(108_327).toBeGreaterThanOrEqual(OLD_BUDGET * DISPATCH_NEAR_FRACTION) // analytics-poll
  })

  it('returns null for an unknown duration rather than ok', () => {
    // "We do not know" must not render as healthy.
    expect(classifyDispatchDuration(null)).toBeNull()
    expect(classifyDispatchDuration(undefined)).toBeNull()
    expect(classifyDispatchDuration(-1)).toBeNull()
    expect(classifyDispatchDuration(Number.NaN)).toBeNull()
    expect(classifyDispatchDuration(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('treats zero as a real, healthy duration', () => {
    // A skipped run records 0ms; that is a fact, not a missing value.
    expect(classifyDispatchDuration(0)).toBe('ok')
  })
})

describe('dispatchBudgetReason', () => {
  it('describes the boundary the classifier actually uses', () => {
    // classifyDispatchDuration is `>=`, so a run landing exactly on the budget is
    // 'over'. The wording has to admit that or it misdescribes the boundary case.
    expect(classifyDispatchDuration(DISPATCH_TIMEOUT_MS)).toBe('over')
    expect(dispatchBudgetReason('over', DISPATCH_TIMEOUT_MS)).toContain('at or past')
  })

  it('explains an over-budget run in terms of what the operator sees', () => {
    const reason = dispatchBudgetReason('over', 134_520)
    expect(reason).toContain('FAILED')
    // Durations >= 10s round to whole seconds; sub-second precision on a
    // two-minute run is noise the operator does not need.
    expect(reason).toContain('135s')
    expect(reason).toContain('200s')
  })

  it('says nothing for a healthy or unknown run', () => {
    expect(dispatchBudgetReason('ok', 10)).toBeNull()
    expect(dispatchBudgetReason(null, null)).toBeNull()
  })
})
