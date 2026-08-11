/*
 * T6 — both trend charts share ONE x-extent.
 *
 * `ScopeRegional.vue` and `ScopeAcrossRegions.vue` each carried a byte-duplicate
 * `todayMs()` / `daysAgo()` pair and each built the rolling window's right edge
 * from the browser's today. Two HIGH findings, one cause: a copy. The reader
 * compares the regional trend and the whole-company trend side by side, so two
 * independently-computed edges is two charts that can name different "now"s —
 * and a fix landing on one copy leaves the other silently wrong.
 *
 * The proof has two halves, because a behavioural test alone would pass on two
 * copies that happen to agree:
 *   1. the function is deterministic and ends at the SETTLED edge;
 *   2. neither container computes a window of its own any more.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { rollingTrendWindow } from '../../../app/components/reporting/trend-window'
import { resolveServerClock } from '../../../shared/reports/clock'

const ROOT = resolve(__dirname, '../../..')
const CONTAINERS = [
  'app/components/reporting/ScopeRegional.vue',
  'app/components/reporting/ScopeAcrossRegions.vue',
] as const

const clock = resolveServerClock(new Date('2026-08-05T09:14:00Z'))

describe('rollingTrendWindow', () => {
  it('ends at the SETTLED edge, not at today', () => {
    const w = rollingTrendWindow(clock, 60)
    expect(w.to).toBe('2026-08-04')
    expect(w.to).not.toBe(clock.today)
  })

  it('spans exactly `days` days, inclusive of both bounds', () => {
    expect(rollingTrendWindow(clock, 60)).toEqual({ from: '2026-06-06', to: '2026-08-04' })
    expect(rollingTrendWindow(clock, 1)).toEqual({ from: '2026-08-04', to: '2026-08-04' })
    expect(rollingTrendWindow(clock, 30)).toEqual({ from: '2026-07-06', to: '2026-08-04' })
  })

  it('is a pure function of the clock — one clock in, one window out', () => {
    expect(rollingTrendWindow(clock, 60)).toEqual(rollingTrendWindow(clock, 60))
  })

  it('both scopes calling it with the same clock get the SAME extent', () => {
    // The property the two byte-duplicate copies could not offer.
    const regional = rollingTrendWindow(clock, 60)
    const across = rollingTrendWindow(clock, 60)
    expect(regional).toEqual(across)
  })
})

describe('neither container defines a window of its own', () => {
  it.each(CONTAINERS)('%s imports the shared window helper', (rel) => {
    const src = readFileSync(resolve(ROOT, rel), 'utf8')
    expect(src).toContain("from './trend-window'")
    expect(src).toContain('rollingTrendWindow(')
  })

  it.each(CONTAINERS)('%s no longer holds its own todayMs/daysAgo pair', (rel) => {
    const src = readFileSync(resolve(ROOT, rel), 'utf8')
    // The exact duplicated helpers the audit named. Their return is the browser's
    // today, so their presence IS the second clock.
    expect(src).not.toMatch(/function\s+todayMs\s*\(/)
    expect(src).not.toMatch(/function\s+daysAgo\s*\(/)
  })

  it('both containers use the SAME rolling span, so the two extents are comparable', () => {
    // A shared function with two different `days` arguments would still draw two
    // different x-extents; the constant is part of the contract.
    const spans = CONTAINERS.map((rel) => {
      const src = readFileSync(resolve(ROOT, rel), 'utf8')
      return /const ROLLING_DAYS = (\d+)/.exec(src)?.[1]
    })
    expect(spans[0]).toBeDefined()
    expect(spans[1]).toBe(spans[0])
  })
})
