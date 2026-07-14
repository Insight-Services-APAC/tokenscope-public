/*
 * useFormat guards (FE-12 / SYS-5) — money/token/time formatters must never
 * render "$NaN" / "NaNd ago" into financial columns: missing or malformed
 * input falls back to an em-dash. Also covers the consolidated options the
 * per-page copies needed (whole-dollar mode, B token tier, signed negatives).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fmtUsd, fmtTokens, fmtTimeAgo, fmtPct, signedPct } from '../../../app/composables/useFormat'

describe('fmtUsd', () => {
  it('formats cents with thousands separators by default', () => {
    expect(fmtUsd(1234.5)).toBe('$1,234.50')
    expect(fmtUsd('1234.5')).toBe('$1,234.50')
    expect(fmtUsd(0)).toBe('$0.00')
  })

  it('whole-dollar mode rounds to integers (finance/rollup tables)', () => {
    expect(fmtUsd(1234.56, { whole: true })).toBe('$1,235')
    expect(fmtUsd('0.4', { whole: true })).toBe('$0')
  })

  it('renders negatives with a leading sign, not "$-x"', () => {
    expect(fmtUsd(-12.5)).toBe('-$12.50')
    expect(fmtUsd('-1234.56')).toBe('-$1,234.56')
  })

  it('falls back to an em-dash for missing/malformed input', () => {
    expect(fmtUsd(undefined)).toBe('—')
    expect(fmtUsd(null)).toBe('—')
    expect(fmtUsd('')).toBe('—')
    expect(fmtUsd('not-a-number')).toBe('—')
    expect(fmtUsd(Number.NaN)).toBe('—')
    expect(fmtUsd(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('fmtTokens', () => {
  it('tiers K / M / B', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(1_500)).toBe('1.5K')
    expect(fmtTokens(2_500_000)).toBe('2.50M')
    expect(fmtTokens(3_250_000_000)).toBe('3.25B')
  })

  it('accepts numeric strings (rollup rows return numerics as strings)', () => {
    expect(fmtTokens('1500')).toBe('1.5K')
  })

  it('falls back to an em-dash for missing/malformed input', () => {
    expect(fmtTokens(undefined)).toBe('—')
    expect(fmtTokens(null)).toBe('—')
    expect(fmtTokens('')).toBe('—')
    expect(fmtTokens('garbage')).toBe('—')
    expect(fmtTokens(Number.NaN)).toBe('—')
  })
})

describe('fmtPct', () => {
  it('formats a 0..1 fraction as a whole percent by default', () => {
    expect(fmtPct(0.423)).toBe('42%')
    expect(fmtPct(1)).toBe('100%')
    expect(fmtPct(0)).toBe('0%')
  })

  it('honours a digits option', () => {
    expect(fmtPct(0.4237, { digits: 1 })).toBe('42.4%')
  })

  it('falls back to an em-dash for missing/malformed input', () => {
    expect(fmtPct(null)).toBe('—')
    expect(fmtPct(undefined)).toBe('—')
    expect(fmtPct('')).toBe('—')
    expect(fmtPct(Number.NaN)).toBe('—')
  })
})

describe('signedPct', () => {
  it('always carries an explicit sign', () => {
    expect(signedPct(0.12)).toBe('+12%')
    expect(signedPct(-0.12)).toBe('-12%')
    expect(signedPct(0)).toBe('+0%')
  })

  it('falls back to an em-dash for missing/malformed input', () => {
    expect(signedPct(null)).toBe('—')
    expect(signedPct(Number.NaN)).toBe('—')
  })
})

describe('fmtTimeAgo', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders relative tiers from a valid ISO timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-09T12:00:00Z'))
    expect(fmtTimeAgo('2026-06-09T11:59:50Z')).toBe('just now')
    expect(fmtTimeAgo('2026-06-09T11:30:00Z')).toBe('30m ago')
    expect(fmtTimeAgo('2026-06-09T07:00:00Z')).toBe('5h ago')
    expect(fmtTimeAgo('2026-06-06T12:00:00Z')).toBe('3d ago')
  })

  it('falls back to an em-dash for missing/unparseable timestamps', () => {
    expect(fmtTimeAgo(undefined)).toBe('—')
    expect(fmtTimeAgo(null)).toBe('—')
    expect(fmtTimeAgo('')).toBe('—')
    expect(fmtTimeAgo('not-a-date')).toBe('—')
  })
})
