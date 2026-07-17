/*
 * build-practice-bill-lanes — the pure builders behind the practice page's §B
 * bill-lane cards (lane-visuals V4, r3-4). Pins:
 *   - the MTD "Reconciled bill by surface" bar FOLDS at the SHARED page cap
 *     (MAX_CHART_LANES — never unbounded slivers) and conserves (Σ folded ==
 *     Σ input, negative/credit lanes NET IN rather than dropping);
 *   - the weekly stack folds at the SAME cap, so the two cards' kept-lane sets
 *     are identical and the one page legend maps to visible marks in BOTH;
 *   - laneIds expose kept + remainder for the page-legend union.
 */
import { describe, it, expect } from 'vitest'
import {
  buildPracticeBillLanes,
  buildPracticeBillWeekly,
} from '../../../app/components/reporting/build-practice-bill-lanes'
import { FOLDED_LANE_ID, MAX_CHART_LANES } from '../../../app/components/reporting/charts/fold-lanes'

const row = (lane: string, billUsd: number) => ({ lane, label: lane.toUpperCase(), billUsd })

/** 8 live surfaces — the "every Claude surface live" practice. */
const eightLanes = [
  row('claude', 50),
  row('claude-ai', 40),
  row('claude-cowork', 30),
  row('claude-office', 20),
  row('claude-chrome', 10),
  row('claude-design', 5),
  row('claude-slack', 2),
  row('claude-other', 1),
]

describe('buildPracticeBillLanes (MTD bar, r3-4)', () => {
  it('folds beyond MAX_CHART_LANES into the single remainder — never 8+ unbounded slivers', () => {
    const total = eightLanes.reduce((a, l) => a + l.billUsd, 0)
    const b = buildPracticeBillLanes(eightLanes, total)
    expect(b.lanes).toHaveLength(MAX_CHART_LANES)
    expect(b.lanes.at(-1)!.lane).toBe(FOLDED_LANE_ID)
    // Conservation: Σ folded rows == Σ input; shares sum to 1 against the bill.
    const sum = b.lanes.reduce((a, l) => a + l.billUsd, 0)
    expect(sum).toBeCloseTo(total, 9)
    expect(b.lanes.reduce((a, l) => a + l.shareOfBill, 0)).toBeCloseTo(1, 9)
    // The remainder itemises exactly the folded lanes.
    expect(b.folded.map((f) => f.lane)).toEqual(['claude-chrome', 'claude-design', 'claude-slack', 'claude-other'])
  })

  it('is the identity (no remainder) when the lanes fit; zero lanes elided', () => {
    const b = buildPracticeBillLanes([row('claude', 10), row('copilot', 0), row('claude-ai', 2)], 12)
    expect(b.lanes.map((l) => l.lane)).toEqual(['claude', 'claude-ai'])
    expect(b.folded).toEqual([])
  })

  it('a NEGATIVE (credit) lane NETS IN — Σ preserved, never silently dropped', () => {
    const b = buildPracticeBillLanes([row('claude', 100), row('claude-ai', -12.34)], 87.66)
    expect(b.lanes.map((l) => l.lane)).toEqual(['claude', 'claude-ai'])
    expect(b.lanes.reduce((a, l) => a + l.billUsd, 0)).toBeCloseTo(87.66, 9)
  })
})

describe('buildPracticeBillWeekly (weekly stack, V4)', () => {
  const cells = eightLanes.flatMap((l) => [
    { weekStart: '2026-06-29', lane: l.lane, usd: l.billUsd },
    { weekStart: '2026-07-06', lane: l.lane, usd: l.billUsd / 2 },
  ])

  it('folds at the SAME shared cap and conserves per week', () => {
    const b = buildPracticeBillWeekly(cells)
    expect(b.laneIds).toHaveLength(MAX_CHART_LANES)
    expect(b.laneIds.at(-1)).toBe(FOLDED_LANE_ID)
    const weekTotal = eightLanes.reduce((a, l) => a + l.billUsd, 0)
    expect(b.bars.map((bar) => bar.weekStart)).toEqual(['2026-06-29', '2026-07-06'])
    expect(b.bars[0]!.totalUsd).toBeCloseTo(weekTotal, 9)
    expect(b.bars[1]!.totalUsd).toBeCloseTo(weekTotal / 2, 9)
  })

  it('KEPT-SET CONSISTENCY (r3-4): the MTD bar and the weekly stack keep the SAME lanes', () => {
    const total = eightLanes.reduce((a, l) => a + l.billUsd, 0)
    const mtd = buildPracticeBillLanes(eightLanes, total)
    const weekly = buildPracticeBillWeekly(cells)
    // One page, one legend, one cap — a lane is either its own colour in BOTH
    // cards or folded in BOTH.
    expect(mtd.lanes.map((l) => l.lane)).toEqual(weekly.laneIds)
  })

  it('returns empty on no rows', () => {
    expect(buildPracticeBillWeekly([])).toEqual({ bars: [], laneIds: [] })
  })

  it('a NEGATIVE (credit) week segment NETS IN — Σ segments == the week showback truth, never silently dropped (review r2 HIGH)', () => {
    const withCredit = [
      { weekStart: '2026-06-29', lane: 'claude', usd: 100 },
      { weekStart: '2026-06-29', lane: 'claude-ai', usd: -12.34 },
    ]
    const b = buildPracticeBillWeekly(withCredit)
    const bar = b.bars[0]!
    // The credit lane must appear as a segment and net the total to 87.66 —
    // a `> 0` filter would report 100 and hide the adjustment.
    expect(bar.segments.map((s) => s.lane)).toContain('claude-ai')
    expect(bar.totalUsd).toBeCloseTo(87.66, 9)
    expect(bar.segments.reduce((a, s) => a + s.usd, 0)).toBeCloseTo(bar.totalUsd, 9)
  })
})
