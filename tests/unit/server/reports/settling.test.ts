// @vitest-environment node
/*
 * reports/settling — the settling matrix (build-design §5 / §7(6)):
 *   - each (provider, month, now) flips EXACTLY at settlesAt
 *   - open month → estimated (no horizon)
 *   - the string "finalised" is never emitted
 *   - a `settled` payload still carries closeRun: false (no close machinery)
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_GITHUB_SETTLE_DAYS,
  providerStatesForMonth,
  providerStatesForWindow,
  settlingState,
} from '../../../../server/reports/settling'

const MONTH = '2026-05' // closes at 2026-06-01T00:00:00Z

describe('providerStatesForWindow — the LEAST settled (last) month of a range', () => {
  // Q2 window [Apr 1, Jul 1) viewed mid-July: April is fully settled, June is not.
  const now = new Date('2026-07-15T00:00:00.000Z')
  const q2 = { monthStr: null, endIso: '2026-07-01T00:00:00.000Z' }

  it('reports the LAST month state, never the over-settled start month', () => {
    const win = providerStatesForWindow(q2, now)
    // Equals the last month (June), NOT the start month (April).
    expect(win).toEqual(providerStatesForMonth('2026-06', now))
    expect(providerStatesForMonth('2026-04', now).every((s) => s.state === 'settled')).toBe(true)
    // June is still settling → the window must NOT overclaim "settled" off April.
    expect(win.some((s) => s.state !== 'settled')).toBe(true)
  })

  it('month mode is identical to providerStatesForMonth', () => {
    expect(providerStatesForWindow({ monthStr: '2026-05', endIso: '2026-06-01T00:00:00.000Z' }, now)).toEqual(
      providerStatesForMonth('2026-05', now),
    )
  })
})

describe('open month → estimated (no horizon)', () => {
  it('while the month is still in progress, every vendor is estimated', () => {
    const now = new Date('2026-05-15T00:00:00Z')
    for (const s of providerStatesForMonth(MONTH, now)) {
      expect(s.state).toBe('estimated')
      expect(s.settlesAt).toBeUndefined()
      expect(s.closeRun).toBe(false)
    }
  })
})

describe('per-vendor horizons flip exactly at settlesAt', () => {
  // anthropic +30d = 2026-07-01; github +7d = 2026-06-08; usage +35d = 2026-07-06.
  const cases: Array<{ vendor: 'anthropic' | 'github' | 'usage'; settlesAt: string }> = [
    { vendor: 'anthropic', settlesAt: '2026-07-01T00:00:00.000Z' },
    { vendor: 'github', settlesAt: '2026-06-08T00:00:00.000Z' },
    { vendor: 'usage', settlesAt: '2026-07-06T00:00:00.000Z' },
  ]

  for (const { vendor, settlesAt } of cases) {
    it(`${vendor}: settling before ${settlesAt}, settled AT and after it`, () => {
      const horizon = new Date(settlesAt)

      const justBefore = settlingState(MONTH, vendor, new Date(horizon.getTime() - 1))
      expect(justBefore.state).toBe('settling')
      expect(justBefore.settlesAt).toBe(settlesAt)
      expect(justBefore.closeRun).toBe(false)

      const atHorizon = settlingState(MONTH, vendor, horizon)
      expect(atHorizon.state).toBe('settled') // flips exactly AT settlesAt
      expect(atHorizon.settlesAt).toBe(settlesAt)
      expect(atHorizon.closeRun).toBe(false) // provisional — no close run

      const wellAfter = settlingState(MONTH, vendor, new Date('2026-09-01T00:00:00Z'))
      expect(wellAfter.state).toBe('settled')
      expect(wellAfter.closeRun).toBe(false)
    })
  }

  it('a closed month just after close is settling for anthropic but settled for github (shorter horizon)', () => {
    const now = new Date('2026-06-09T00:00:00Z') // past github +7, before anthropic +30
    expect(settlingState(MONTH, 'github', now).state).toBe('settled')
    expect(settlingState(MONTH, 'anthropic', now).state).toBe('settling')
    expect(settlingState(MONTH, 'usage', now).state).toBe('settling')
  })
})

describe('github settle window is configurable (provider_enterprise; default 7)', () => {
  it('defaults to 7 days', () => {
    expect(DEFAULT_GITHUB_SETTLE_DAYS).toBe(7)
  })
  it('honours githubSettleDays config', () => {
    const s = settlingState(MONTH, 'github', new Date('2026-06-10T00:00:00Z'), {
      githubSettleDays: 14,
    })
    expect(s.state).toBe('settling') // 06-10 < 06-15 (close + 14d)
    expect(s.settlesAt).toBe('2026-06-15T00:00:00.000Z')
  })
})

describe('"finalised" is grep-banned and never emitted; states stay in the allowed set', () => {
  it('no rendered state string is "finalised" across the whole horizon sweep', () => {
    const allowed = new Set(['estimated', 'settling', 'settled'])
    for (const now of [
      new Date('2026-05-10T00:00:00Z'),
      new Date('2026-06-05T00:00:00Z'),
      new Date('2026-08-01T00:00:00Z'),
    ]) {
      const payload = providerStatesForMonth(MONTH, now)
      expect(payload).toHaveLength(3)
      expect(JSON.stringify(payload)).not.toContain('finalised')
      for (const s of payload) expect(allowed.has(s.state)).toBe(true)
    }
  })
})
