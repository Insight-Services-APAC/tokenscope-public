/*
 * build-trend / build-regional-trend — the pure projection builders behind the
 * Across + Regional spend-trend charts. These lock the run-rate REGRESSION: the
 * dashed forecast tail must project the CURRENT-MONTH MTD daily rate, NOT the whole
 * (rolling, up-to-60-day) window total ÷ the current month's elapsed days — the
 * latter inflated the projected daily rate ~20× (a $3.8k/day spike over ~$300/day
 * actuals). See the reporting-redesign review, finding F5.
 */
import { describe, it, expect } from 'vitest'
import { buildAcrossTrend } from '../../../app/components/reporting/across/build-trend'
import { buildRegionalTrend } from '../../../app/components/reporting/regional/build-regional-trend'
import type { AcrossTrendPoint, Forecast } from '../../../shared/reports/types'

/** In-progress July forecast: 3 of 31 days elapsed. */
const JULY_FORECAST: Forecast = {
  asOfDate: '2026-07-03',
  daysElapsed: 3,
  daysInMonth: 31,
  factor: 31 / 3,
  meteredMtdUsd: 300,
  meteredProjectedUsd: 3100,
  projectedUsd: 3100,
}

/** A rolling 60-day-style window: 30 June days at $300 + 3 July days at $100. */
function acrossPoints(): AcrossTrendPoint[] {
  const pts: AcrossTrendPoint[] = []
  for (let d = 1; d <= 30; d++) {
    pts.push({ day: `2026-06-${String(d).padStart(2, '0')}`, key: 'claude-code', value: 300 })
  }
  for (let d = 1; d <= 3; d++) {
    pts.push({ day: `2026-07-${String(d).padStart(2, '0')}`, key: 'claude-code', value: 100 })
  }
  return pts
}

describe('buildAcrossTrend — run-rate projection', () => {
  it('projects the CURRENT-MONTH MTD daily rate, not the whole-window total', () => {
    const { series, forecastFrom } = buildAcrossTrend(acrossPoints(), JULY_FORECAST, '2026-07')
    expect(forecastFrom).toBe('2026-07-04')
    const claude = series.find((s) => s.key === 'claude-code')!
    const firstProjected = claude.data.find((p) => p.x === '2026-07-04')!
    // July MTD = 3 × $100 = $300; ÷ 3 elapsed days = $100/day. NOT (9000+300)/3 = $3100.
    expect(firstProjected.y).toBeCloseTo(100, 5)
    expect(firstProjected.y).toBeLessThan(300) // guards the ~20x inflation regression
    // Tail spans 2026-07-04 .. 2026-07-31 (28 days), all at the same run-rate.
    const projected = claude.data.filter((p) => p.x > '2026-07-03')
    expect(projected).toHaveLength(28)
    expect(projected.every((p) => Math.abs(p.y - 100) < 1e-6)).toBe(true)
  })

  it('emits actual points + dailyTotals for every day with data (no synthetic pre-fill)', () => {
    const { dailyTotals, series } = buildAcrossTrend(acrossPoints(), JULY_FORECAST, '2026-07')
    expect(dailyTotals).toHaveLength(33) // 30 June + 3 July actual days
    expect(dailyTotals.slice(0, 30).every((v) => v === 300)).toBe(true)
    expect(dailyTotals.slice(30).every((v) => v === 100)).toBe(true)
    const claude = series.find((s) => s.key === 'claude-code')!
    expect(claude.data.find((p) => p.x === '2026-06-15')!.y).toBe(300)
  })

  it('no projected tail when the month is complete (asOf on the last day)', () => {
    const complete: Forecast = { ...JULY_FORECAST, asOfDate: '2026-07-31', daysElapsed: 31 }
    const { forecastFrom, series } = buildAcrossTrend(acrossPoints(), complete, '2026-07')
    expect(forecastFrom).toBeUndefined()
    expect(series[0]!.data.every((p) => p.y != null)).toBe(true) // no null-then-projected split
  })

  it('no tail without a forecast or without a month key (custom-range mode)', () => {
    expect(buildAcrossTrend(acrossPoints(), null, '2026-07').forecastFrom).toBeUndefined()
    expect(buildAcrossTrend(acrossPoints(), JULY_FORECAST, null).forecastFrom).toBeUndefined()
  })

  it('projects zero/day when the current month has no MTD rows in the window', () => {
    // Only June data in the window, but an in-progress July forecast (asOf July).
    const juneOnly = acrossPoints().filter((p) => p.day.startsWith('2026-06'))
    const { series } = buildAcrossTrend(juneOnly, JULY_FORECAST, '2026-07')
    const claude = series.find((s) => s.key === 'claude-code')!
    const firstProjected = claude.data.find((p) => p.x === '2026-07-04')!
    expect(firstProjected.y).toBe(0) // MTD sum is 0 ⇒ run-rate 0, NOT June-total ÷ 3
  })
})

describe('buildRegionalTrend — run-rate projection (display-name keys)', () => {
  it('projects the current-month MTD rate, mapping Claude→magenta key', () => {
    const pts = [
      ...Array.from({ length: 30 }, (_, i) => ({ day: `2026-06-${String(i + 1).padStart(2, '0')}`, key: 'Claude', value: 300 })),
      ...Array.from({ length: 3 }, (_, i) => ({ day: `2026-07-${String(i + 1).padStart(2, '0')}`, key: 'Claude', value: 100 })),
    ]
    const { series, forecastFrom } = buildRegionalTrend(pts, JULY_FORECAST, '2026-07')
    expect(forecastFrom).toBe('2026-07-04')
    const claude = series.find((s) => s.key === 'claude-code')! // remapped from 'Claude'
    expect(claude.name).toBe('Claude Code')
    expect(claude.data.find((p) => p.x === '2026-07-04')!.y).toBeCloseTo(100, 5)
  })
})
