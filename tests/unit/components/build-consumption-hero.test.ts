/*
 * build-consumption-hero (visuals-iter2 §I3) — the pure fold/axis maths behind
 * the /consumption "What kind of AI work drove this" hero:
 *   - dense shared Mon-UTC week axis; `partial` ONLY on the current week;
 *   - per-group fold at MAX_CHART_LANES, membership ranked on COMPLETE weeks
 *     (a partial-week spike must not buy a lane its identity — r1-F4);
 *   - conservation: Σ(bar segments) == Σ(input weekly rows) per week per group
 *     (the remainder nets exactly the folded lanes);
 *   - MTD chips: endpoint-provided per-lane MTD, share-of-visible PER GROUP,
 *     remainder chip = Σ folded MTD with an itemised title;
 *   - groups stay independent: no field ever sums across the two bases (r1-F1).
 */
import { describe, it, expect } from 'vitest'
import {
  buildConsumptionHero,
  isoWeekStartUtc,
  type HeroGroupWire,
  type HeroLaneWire,
} from '../../../app/components/consumption/build-consumption-hero'
import {
  FOLDED_LANE_ID,
  MAX_CHART_LANES,
} from '../../../app/components/reporting/charts/fold-lanes'

// Wednesday 2026-07-15 → current week starts Mon 2026-07-13. A SERVER-provided
// ISO date (the endpoint's hero.as_of) — the builder takes no client Date.
const TODAY = '2026-07-15'
const CURRENT_WEEK = '2026-07-13'

function lane(laneId: string, mtd: number, weekly: Array<[string, number]>): HeroLaneWire {
  return {
    lane: laneId,
    label: laneId,
    mtd_usd: mtd.toFixed(2),
    weekly: weekly.map(([week_start, usd]) => ({ week_start, usd: usd.toFixed(2) })),
  }
}

function group(id: string, lanes: HeroLaneWire[]): HeroGroupWire {
  return { id, label: id, basis: `${id} basis`, lanes }
}

describe('buildConsumptionHero — shared week axis', () => {
  it('produces a dense Mon-UTC axis covering the window, partial ONLY on the current week', () => {
    const built = buildConsumptionHero([group('telemetry', [])], 28, TODAY)
    // 28d back from 2026-07-15 → 2026-06-18, whose week starts Mon 2026-06-15.
    expect(built.weeks.map((w) => w.weekStart)).toEqual([
      '2026-06-15',
      '2026-06-22',
      '2026-06-29',
      '2026-07-06',
      '2026-07-13',
    ])
    expect(built.weeks.filter((w) => w.partial).map((w) => w.weekStart)).toEqual([CURRENT_WEEK])
    expect(isoWeekStartUtc(new Date(`${TODAY}T10:00:00Z`))).toBe(CURRENT_WEEK)
  })
})

describe('buildConsumptionHero — fold membership on COMPLETE weeks', () => {
  // 6 lanes > MAX_CHART_LANES(5): top-4 by COMPLETE-week Σ keep identity.
  // 'spike' has $1000 in the PARTIAL week only — it must FOLD (rank 0).
  const lanes = [
    lane('a', 50, [['2026-07-06', 50]]),
    lane('b', 40, [['2026-07-06', 40]]),
    lane('c', 30, [['2026-07-06', 30]]),
    lane('d', 20, [['2026-07-06', 20]]),
    lane('e', 10, [['2026-07-06', 10]]),
    lane('spike', 1000, [[CURRENT_WEEK, 1000]]),
  ]

  it('folds the partial-week-only spike lane; kept set = top complete-week lanes', () => {
    const [g] = buildConsumptionHero([group('billed', lanes)], 28, TODAY).groups
    expect(g!.laneIds).toEqual(['a', 'b', 'c', 'd', FOLDED_LANE_ID])
    expect(g!.laneIds).toHaveLength(MAX_CHART_LANES)
  })

  it('the remainder still CARRIES the folded lanes’ partial-week dollars (conservation)', () => {
    const [g] = buildConsumptionHero([group('billed', lanes)], 28, TODAY).groups
    const partialBar = g!.bars.find((b) => b.weekStart === CURRENT_WEEK)!
    expect(partialBar.partial).toBe(true)
    const remainder = partialBar.segments.find((s) => s.lane === FOLDED_LANE_ID)
    expect(remainder?.usd).toBeCloseTo(1000, 6)
  })

  it('per-week conservation: Σ segments == Σ input weekly rows, every week', () => {
    const [g] = buildConsumptionHero([group('billed', lanes)], 28, TODAY).groups
    for (const w of ['2026-07-06', CURRENT_WEEK]) {
      const inputSum = lanes.reduce(
        (a, l) => a + l.weekly.filter((r) => r.week_start === w).reduce((x, r) => x + Number(r.usd), 0),
        0,
      )
      const bar = g!.bars.find((b) => b.weekStart === w)!
      expect(bar.segments.reduce((a, s) => a + s.usd, 0)).toBeCloseTo(inputSum, 6)
      expect(bar.totalUsd).toBeCloseTo(inputSum, 6)
    }
  })

  it('no fold when the lane count fits the cap', () => {
    const [g] = buildConsumptionHero([group('telemetry', lanes.slice(0, 3))], 28, TODAY).groups
    expect(g!.laneIds).toEqual(['a', 'b', 'c'])
    expect(g!.bars.flatMap((b) => b.segments).some((s) => s.lane === FOLDED_LANE_ID)).toBe(false)
  })
})

describe('buildConsumptionHero — MTD chips per basis group', () => {
  const lanes = [
    lane('a', 50, [['2026-07-06', 50]]),
    lane('b', 40, [['2026-07-06', 40]]),
    lane('c', 30, [['2026-07-06', 30]]),
    lane('d', 20, [['2026-07-06', 20]]),
    lane('e', 10, [['2026-07-06', 10]]),
    lane('f', 5, [['2026-07-06', 5]]),
  ]

  it('remainder chip = Σ folded MTD, itemised; shares sum to 1 within the group', () => {
    const [g] = buildConsumptionHero([group('billed', lanes)], 28, TODAY).groups
    const chips = g!.chips
    expect(chips.map((c) => c.lane)).toEqual(['a', 'b', 'c', 'd', FOLDED_LANE_ID])
    const remainder = chips.find((c) => c.lane === FOLDED_LANE_ID)!
    expect(remainder.mtdUsd).toBeCloseTo(15, 6) // e(10) + f(5)
    expect(remainder.foldedTitle).toContain('e $10.00')
    expect(remainder.foldedTitle).toContain('f $5.00')
    expect(chips.reduce((a, c) => a + c.share, 0)).toBeCloseTo(1, 6)
  })

  it('groups stay independent — chips/shares/scales computed per group, never across', () => {
    const built = buildConsumptionHero(
      [
        group('telemetry', [lane('claude', 100, [['2026-07-06', 100]])]),
        group('billed', [lane('claude-ai', 900, [['2026-07-06', 900]])]),
      ],
      28,
      TODAY,
    )
    const [tel, billed] = built.groups
    // Each single-lane group holds 100% of ITS OWN visible MTD.
    expect(tel!.chips[0]!.share).toBeCloseTo(1, 6)
    expect(billed!.chips[0]!.share).toBeCloseTo(1, 6)
    // Each group scales its own bars — no shared max across bases.
    expect(tel!.maxUsd).toBeCloseTo(100, 6)
    expect(billed!.maxUsd).toBeCloseTo(900, 6)
  })

  it('zero-MTD group yields zero shares (no divide-by-zero)', () => {
    const [g] = buildConsumptionHero([group('telemetry', [lane('claude', 0, [])])], 28, TODAY).groups
    expect(g!.chips[0]!.share).toBe(0)
  })
})
