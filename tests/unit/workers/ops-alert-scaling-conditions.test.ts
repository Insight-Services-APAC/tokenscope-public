// @vitest-environment node
/*
 * The two ops-alert conditions the scaling plan adds, as pure decisions
 * (docs/design/scaling-to-1000-users.md 0.3 and 0.5). The integration file
 * (tests/integration/workers/ops-alert.test.ts) drives them through the worker
 * and the state machine; this pins the arithmetic.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DISPATCH_NEAR_FRACTION,
  DISPATCH_TIMEOUT_MS,
} from '../../../shared/workers/dispatch-budget'
import {
  TELEMETRY_CAP_FRACTION,
  decideTelemetryCap,
  isWorkerNearDispatchBudget,
  telemetryDailyCapGbFromEnv,
} from '../../../server/workers/ops-alert'

const NEAR_MS = DISPATCH_TIMEOUT_MS * DISPATCH_NEAR_FRACTION

describe('isWorkerNearDispatchBudget', () => {
  it('holds for two consecutive near-or-over runs', () => {
    expect(isWorkerNearDispatchBudget([NEAR_MS, NEAR_MS])).toBe(true)
    expect(isWorkerNearDispatchBudget([DISPATCH_TIMEOUT_MS, NEAR_MS])).toBe(true)
    expect(isWorkerNearDispatchBudget([DISPATCH_TIMEOUT_MS + 1, DISPATCH_TIMEOUT_MS])).toBe(true)
  })

  it('does not hold for one run, or for none', () => {
    expect(isWorkerNearDispatchBudget([DISPATCH_TIMEOUT_MS])).toBe(false)
    expect(isWorkerNearDispatchBudget([])).toBe(false)
  })

  it('does not hold when the latest run is ok', () => {
    expect(isWorkerNearDispatchBudget([NEAR_MS - 1, DISPATCH_TIMEOUT_MS, DISPATCH_TIMEOUT_MS])).toBe(false)
  })

  it('does not hold when the older of the two is ok', () => {
    expect(isWorkerNearDispatchBudget([DISPATCH_TIMEOUT_MS, NEAR_MS - 1])).toBe(false)
  })

  it('skips invalid durations rather than counting them, in either direction', () => {
    expect(isWorkerNearDispatchBudget([null, Number.NaN, -1, NEAR_MS, NEAR_MS])).toBe(true)
    expect(isWorkerNearDispatchBudget([NEAR_MS, null])).toBe(false)
    expect(isWorkerNearDispatchBudget([Number.POSITIVE_INFINITY, NEAR_MS])).toBe(false)
  })

  it('the boundary is the classifier\'s: exactly DISPATCH_NEAR_FRACTION of the budget holds, 1 ms under does not', () => {
    expect(isWorkerNearDispatchBudget([NEAR_MS, NEAR_MS])).toBe(true)
    expect(isWorkerNearDispatchBudget([NEAR_MS - 1, NEAR_MS - 1])).toBe(false)
  })
})

describe('isWorkerNearDispatchBudget reuses classifyDispatchDuration (no second definition)', () => {
  afterEach(() => {
    vi.doUnmock('../../../shared/workers/dispatch-budget')
    vi.resetModules()
  })

  it('a different near fraction in the shared module moves the condition', async () => {
    vi.resetModules()
    vi.doMock('../../../shared/workers/dispatch-budget', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../../shared/workers/dispatch-budget')>()
      const fraction = 0.25
      return {
        ...real,
        DISPATCH_NEAR_FRACTION: fraction,
        classifyDispatchDuration: (d: number | null | undefined) => {
          if (d == null || !Number.isFinite(d) || d < 0) return null
          if (d >= real.DISPATCH_TIMEOUT_MS) return 'over'
          return d >= real.DISPATCH_TIMEOUT_MS * fraction ? 'near' : 'ok'
        },
      }
    })
    const { isWorkerNearDispatchBudget: fresh } = await import('../../../server/workers/ops-alert')
    // 60 s is 'ok' at the real 0.8 and 'near' at 0.25.
    expect(isWorkerNearDispatchBudget([60_000, 60_000])).toBe(false)
    expect(fresh([60_000, 60_000])).toBe(true)
  })
})

describe('decideTelemetryCap', () => {
  // 2 GB = 2000 MB; 80% = 1600 MB.
  it('holds at 80% of the cap and reports the percent used', () => {
    expect(TELEMETRY_CAP_FRACTION).toBe(0.8)
    expect(decideTelemetryCap({ megabytes: 1_600 }, 2)).toEqual({ verdict: 'hold', percentOfCap: 80 })
    expect(decideTelemetryCap({ megabytes: 2_500 }, 2)).toEqual({ verdict: 'hold', percentOfCap: 125 })
  })

  it('clears below 80%, including a real zero', () => {
    expect(decideTelemetryCap({ megabytes: 1_599.99 }, 2)).toEqual({ verdict: 'clear' })
    expect(decideTelemetryCap({ megabytes: 0 }, 2)).toEqual({ verdict: 'clear' })
  })

  it('is indeterminate when the reading is unknown — never treated as zero', () => {
    expect(decideTelemetryCap(null, 2)).toEqual({ verdict: 'indeterminate' })
    expect(decideTelemetryCap({ megabytes: null }, 2)).toEqual({ verdict: 'indeterminate' })
    expect(decideTelemetryCap({ megabytes: Number.NaN }, 2)).toEqual({ verdict: 'indeterminate' })
    expect(decideTelemetryCap({ megabytes: -5 }, 2)).toEqual({ verdict: 'indeterminate' })
  })

  it('is indeterminate when the cap is unknown or not positive', () => {
    expect(decideTelemetryCap({ megabytes: 1_900 }, null)).toEqual({ verdict: 'indeterminate' })
    expect(decideTelemetryCap({ megabytes: 1_900 }, 0)).toEqual({ verdict: 'indeterminate' })
    expect(decideTelemetryCap({ megabytes: 1_900 }, -2)).toEqual({ verdict: 'indeterminate' })
  })
})

describe('telemetryDailyCapGbFromEnv', () => {
  it('reads a positive number', () => {
    expect(telemetryDailyCapGbFromEnv('2')).toBe(2)
    expect(telemetryDailyCapGbFromEnv('0.5')).toBe(0.5)
  })

  it.each([undefined, '', '  ', '0', '-1', 'two', 'NaN', 'Infinity'])('%j is no cap', (raw) => {
    expect(telemetryDailyCapGbFromEnv(raw)).toBeNull()
  })
})
