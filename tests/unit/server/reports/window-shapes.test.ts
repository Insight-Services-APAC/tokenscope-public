// @vitest-environment node
/*
 * Pure reporting-shape units (no DB) added in the /reporting redesign wave B:
 *   - momPaceWindow — the LIKE-FOR-LIKE month-over-month operand (the pace fix):
 *     the previous month clipped to the SAME day-of-month as the viewed month, so a
 *     reading N days into a month compares against the previous month's first N days
 *     (NOT its full total — the spurious-early-drop bug).
 *   - buildSeasonality — ISO-week axis (oldest→newest) + weekIdx-indexed cells.
 *   - costCentreBudgetState + summariseCostCentres — the CC RAG rollup (one shared
 *     classifier the summary counts + the per-card colouring both key on).
 */
import { describe, it, expect } from 'vitest'
import { momPaceWindow, buildSeasonality } from '../../../../server/reporting/params'
import { summariseCostCentres, type CostCentreCard } from '../../../../server/reporting/cost-centres'
import { costCentreBudgetState } from '../../../../shared/reports/types'
import { monthRangeUtc } from '../../../../server/utils/period'

describe('momPaceWindow — like-for-like MoM operand (the pace fix)', () => {
  it('in-progress month, 3 days in → prev window is the FIRST 3 days of the previous month', () => {
    // Viewing July while 3 days into it → compare against June 1–3, not all of June.
    const w = momPaceWindow(monthRangeUtc('2026-07'), new Date('2026-07-03T12:00:00Z'))
    expect(w.startIso).toBe('2026-06-01T00:00:00.000Z')
    expect(w.endIso).toBe('2026-06-04T00:00:00.000Z') // exclusive → covers June 1,2,3
  })

  it('day 1 of the month → prev window is just the previous month day 1', () => {
    const w = momPaceWindow(monthRangeUtc('2026-07'), new Date('2026-07-01T00:00:00Z'))
    expect(w.startIso).toBe('2026-06-01T00:00:00.000Z')
    expect(w.endIso).toBe('2026-06-02T00:00:00.000Z')
  })

  it('a COMPLETE month (as-of on its last day) → the WHOLE previous month', () => {
    // A month whose data runs to its last day paces to the full previous month.
    // The pace anchor is the DATA frontier (as-of), always inside the viewed month,
    // so the closed-month case falls out of the same expression as in-progress.
    const w = momPaceWindow(monthRangeUtc('2026-05'), new Date('2026-05-31T00:00:00Z'))
    expect(w.startIso).toBe('2026-04-01T00:00:00.000Z')
    expect(w.endIso).toBe('2026-05-01T00:00:00.000Z') // exclusive → all of April
  })

  it('day-of-month beyond the previous month length is CLAMPED to its last instant', () => {
    // As-of March 31 → February has only 28 days (2026): clamp to the whole of February.
    const w = momPaceWindow(monthRangeUtc('2026-03'), new Date('2026-03-31T12:00:00Z'))
    expect(w.startIso).toBe('2026-02-01T00:00:00.000Z')
    expect(w.endIso).toBe('2026-03-01T00:00:00.000Z')
  })
})

describe('buildSeasonality — ISO-week axis + indexed cells', () => {
  it('orders weeks oldest→newest and indexes every cell into that axis', () => {
    const { weeks, cells } = buildSeasonality([
      { iso_week: '2026-W27', dow: 0, value: '10' },
      { iso_week: '2026-W26', dow: 2, value: '5' },
      { iso_week: '2026-W27', dow: 3, value: '7.5' },
    ])
    expect(weeks).toEqual(['2026-W26', '2026-W27'])
    expect(cells).toEqual([
      { dow: 0, weekIdx: 1, value: 10 },
      { dow: 2, weekIdx: 0, value: 5 },
      { dow: 3, weekIdx: 1, value: 7.5 },
    ])
  })

  it('sorts correctly across an ISO year boundary (lexical = chronological)', () => {
    const { weeks } = buildSeasonality([
      { iso_week: '2027-W01', dow: 0, value: '1' },
      { iso_week: '2026-W52', dow: 0, value: '1' },
    ])
    expect(weeks).toEqual(['2026-W52', '2027-W01'])
  })

  it('empty input → empty axis + no cells', () => {
    expect(buildSeasonality([])).toEqual({ weeks: [], cells: [] })
  })
})

describe('costCentreBudgetState + summariseCostCentres — CC RAG rollup', () => {
  it('classifies utilisation into none / ok / warn / over at the shared threshold', () => {
    expect(costCentreBudgetState(null)).toBe('none')
    expect(costCentreBudgetState(0.5)).toBe('ok')
    expect(costCentreBudgetState(0.79)).toBe('ok')
    expect(costCentreBudgetState(0.8)).toBe('warn') // threshold is inclusive
    expect(costCentreBudgetState(0.99)).toBe('warn')
    expect(costCentreBudgetState(1)).toBe('over') // at-budget counts as over
    expect(costCentreBudgetState(1.4)).toBe('over')
  })

  it('summarises the visible cards into totals + a partitioning RAG count', () => {
    const card = (burnUsd: number, allocationUsd: number): CostCentreCard => ({
      id: 'x',
      code: 'x',
      displayName: 'x',
      regionCode: 'r',
      burnUsd,
      allocationUsd,
      utilisation: allocationUsd > 0 ? burnUsd / allocationUsd : null,
      exhaustionDate: null,
      forecast: null,
      asOfDate: null,
    })
    const cards = [
      card(120, 100), // over  (1.2)
      card(90, 100), //  warn  (0.9)
      card(10, 100), //  ok    (0.1)
      card(50, 0), //    none  (no allocation)
    ]
    const s = summariseCostCentres(cards, '2026-07-03')
    expect(s.totalBurnUsd).toBe(270)
    expect(s.totalAllocationUsd).toBe(300)
    expect(s.countOverBudget).toBe(1)
    expect(s.countNearBudget).toBe(1)
    expect(s.countOnTrack).toBe(1)
    expect(s.countNoAllocation).toBe(1)
    expect(s.asOfDate).toBe('2026-07-03')
    // The four counts partition the cards exactly.
    const total =
      s.countOverBudget + s.countNearBudget + s.countOnTrack + s.countNoAllocation
    expect(total).toBe(cards.length)
  })
})
