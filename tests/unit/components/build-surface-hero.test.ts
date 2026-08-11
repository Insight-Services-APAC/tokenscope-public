// @vitest-environment node
/*
 * build-surface-hero — the usage-view composition hero + its PINNED donut
 * (requirement 1 — canonical §A USAGE basis). Pins the Conservation section's
 * hero items:
 *   - hero Σ (rendered weekly lane $, incl. the tooltip-flagged partial week)
 *     == Σ(input usage cells), cent-exact;
 *   - donut Σ == hero Σ for the SAME window (one shared window object, r2-2)
 *     — same cells, same fold membership, so the two can never disagree;
 *   - the remainder wears the DISCLOSURE label "Other surfaces (composition
 *     varies)" (r2-1) and itemises per-week composition;
 *   - the page legend derives from the hero's rendered lanes (the donut's are
 *     a subset by construction).
 */
import { describe, it, expect } from 'vitest'
import {
  buildSurfaceHero,
  heroHasData,
  HERO_REMAINDER_LABEL,
} from '../../../app/components/reporting/build-surface-hero'
import { FOLDED_LANE_ID } from '../../../app/components/reporting/charts/fold-lanes'
import type { UsageSurfaceWeeklyCell } from '../../../shared/reports/types'

const cents = (n: number) => Math.round(n * 100)

const FROM = '2026-05-04'
const TO = '2026-07-12'
const TODAY = '2026-07-08' // → partial week 2026-07-06
const COMPLETE = [
  '2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25', '2026-06-01',
  '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29',
]

function makeCells(): UsageSurfaceWeeklyCell[] {
  const cells: UsageSurfaceWeeklyCell[] = []
  for (const w of COMPLETE) {
    cells.push({ weekStart: w, lane: 'claude', usd: 200.07 })
    cells.push({ weekStart: w, lane: 'claude-ai', usd: 90.01 })
    cells.push({ weekStart: w, lane: 'claude-cowork', usd: 40.03 })
    cells.push({ weekStart: w, lane: 'claude-office', usd: 20.11 })
    cells.push({ weekStart: w, lane: 'claude-chrome', usd: 3.33 })
    cells.push({ weekStart: w, lane: 'claude-slack', usd: 1.01 })
  }
  cells.push({ weekStart: '2026-07-06', lane: 'claude', usd: 55.55 })
  cells.push({ weekStart: '2026-07-06', lane: 'claude-chrome', usd: 4.44 })
  return cells
}

describe('buildSurfaceHero — I1 conservation', () => {
  it('hero Σ == Σ(input cells) cent-exact; partial week INCLUDED in the bars', () => {
    const cells = makeCells()
    const hero = buildSurfaceHero(cells, { from: FROM, to: TO, today: TODAY })
    const rendered = hero.series.reduce((a, s) => a + s.data.reduce((x, p) => x + p.y, 0), 0)
    const input = cells.reduce((a, c) => a + c.usd, 0)
    expect(cents(rendered)).toBe(cents(input))
    expect(hero.inProgressWeek).toBe('2026-07-06')
    const partialIdx = hero.weeks.indexOf('2026-07-06')
    const partialSum = hero.series.reduce((a, s) => a + (s.data[partialIdx]?.y ?? 0), 0)
    expect(cents(partialSum)).toBe(cents(55.55 + 4.44))
  })

  it('donut Σ == hero Σ for the SAME window (r2-2), same fold membership', () => {
    const cells = makeCells()
    const hero = buildSurfaceHero(cells, { from: FROM, to: TO, today: TODAY })
    expect(cents(hero.donut.totalUsd)).toBe(cents(hero.totalUsd))
    expect(cents(hero.donut.totalUsd)).toBe(cents(cells.reduce((a, c) => a + c.usd, 0)))
    // Same fold membership: every donut lane is a rendered hero lane.
    for (const lane of hero.donut.laneIds) expect(hero.laneIds).toContain(lane)
    // And each slice equals its lane's whole-window series Σ.
    for (const slice of hero.donut.slices) {
      const s = hero.series.find((x) => x.key === slice.lane)!
      expect(cents(slice.value)).toBe(cents(s.data.reduce((a, p) => a + p.y, 0)))
    }
  })

  it('the remainder wears the disclosure label and itemises per-week composition (r2-1)', () => {
    const hero = buildSurfaceHero(makeCells(), { from: FROM, to: TO, today: TODAY })
    const remainder = hero.series.find((s) => s.key === FOLDED_LANE_ID)!
    expect(remainder.name).toBe(HERO_REMAINDER_LABEL)
    expect(HERO_REMAINDER_LABEL).toBe('Other surfaces (composition varies)')
    // 6 lanes → top-4 kept + 2 folded; the folded pair is itemised per week.
    expect(hero.remainderByWeek['2026-05-04']!.map((i) => i.lane).sort()).toEqual([
      'claude-chrome', 'claude-slack',
    ])
    // The donut's remainder slice carries the same label.
    const donutRemainder = hero.donut.slices.find((s) => s.lane === FOLDED_LANE_ID)!
    expect(donutRemainder.label).toBe(HERO_REMAINDER_LABEL)
  })

  it('empty input has no data and no slices', () => {
    /*
     * `heroLegendLanes` was asserted here too, until the page-level usage legend
     * it fed was replaced by SurfaceHeroCard's own totals bar (built from
     * `donut.slices`, asserted below and in the card's own test). The helper went
     * with the legend; what is left is the property the card actually reads.
     */
    const hero = buildSurfaceHero(makeCells(), { from: FROM, to: TO, today: TODAY })
    expect(heroHasData(hero)).toBe(true)
    const empty = buildSurfaceHero([], { from: FROM, to: TO, today: TODAY })
    expect(heroHasData(empty)).toBe(false)
    expect(empty.donut.slices).toEqual([])
    expect(empty.donut.totalUsd).toBe(0)
  })

  it('delta is present over ≥8 complete weeks and recomputes from the RAW cells', () => {
    const cells = makeCells()
    const hero = buildSurfaceHero(cells, { from: FROM, to: TO, today: TODAY })
    // Independent recompute (raw rows, never the folded output): every complete
    // week is identical, so the last-4 weekly non-Code average IS the per-week sum.
    const nonCodePerWeek = 90.01 + 40.03 + 20.11 + 3.33 + 1.01
    const totalPerWeek = nonCodePerWeek + 200.07
    const rawLast4NonCode = cells
      .filter((c) => COMPLETE.slice(-4).includes(c.weekStart) && c.lane !== 'claude')
      .reduce((a, c) => a + c.usd, 0)
    const d = hero.delta!
    expect(d.nonCodeAvgWeekUsd).toBeCloseTo(rawLast4NonCode / 4, 10)
    expect(d.nonCodeAvgWeekUsd).toBeCloseTo(nonCodePerWeek, 10)
    expect(d.nonCodeMomPct).toBeCloseTo(0, 10) // steady composition → 0% MoM
    expect(d.nonCodeSharePct).toBeCloseTo(nonCodePerWeek / totalPerWeek, 10)
    expect(d.nonCodeShareDeltaPts).toBeCloseTo(0, 10)
  })
})
