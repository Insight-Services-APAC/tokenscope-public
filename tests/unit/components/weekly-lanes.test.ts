// @vitest-environment node
/*
 * weekly-lanes — the kit-level WEEKLY lane folding + partial-week rules behind
 * the usage-view composition hero and the weekly chargeback lane trend
 * (lane-visuals iter-2 I1/I2/I4). Pins the Conservation section:
 *   - Σ(rendered weekly series, incl. the partial week) == Σ(input cells),
 *     cent-exact;
 *   - the share band's rows sum to EXACTLY 100.00 per data week (allocate-cents
 *     largest-remainder — not independent rounding);
 *   - the PARTIAL current week is rendered but EXCLUDED from fold ranking and
 *     from the composition delta (r1-F4);
 *   - the delta is recomputed here INDEPENDENTLY from the raw (unfolded) cells
 *     (r1-F5) — never from the folded output;
 *   - weekly Σ == daily Σ for the same window (the I4 grain-conservation test);
 *   - the peak-day chip binds to the CHART'S OWN day series (r2-3): same
 *     points, projected days excluded, ties to the earliest day.
 */
import { describe, it, expect } from 'vitest'
import {
  buildWeeklyLanes,
  computeCompositionDelta,
  computePeakDay,
  groupLaneDaysToWeeks,
  mondayOf,
  type WeeklyLaneCell,
} from '../../../app/components/reporting/charts/weekly-lanes'
import { buildChargebackLaneTrendWeekly } from '../../../app/components/reporting/build-chargeback-trend'
import { FOLDED_LANE_ID, MAX_CHART_LANES } from '../../../app/components/reporting/charts/fold-lanes'

const cents = (n: number) => Math.round(n * 100)

// Window: Mon 2026-05-04 .. Sun 2026-07-12 (10 ISO weeks); today = Wed 2026-07-08
// → the partial current week is 2026-07-06 and there are 9 complete weeks.
const FROM = '2026-05-04'
const TO = '2026-07-12'
const TODAY = '2026-07-08'
const WEEKS = [
  '2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25', '2026-06-01',
  '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06',
]
const COMPLETE = WEEKS.slice(0, 9)

/** Cent-odd cells over SIX lanes (> MAX_CHART_LANES ⇒ folding occurs). */
function makeCells(): WeeklyLaneCell[] {
  const cells: WeeklyLaneCell[] = []
  // Four big lanes present every complete week (kept by ranking).
  for (const w of COMPLETE) {
    cells.push({ weekStart: w, lane: 'claude', usd: 100.01 })
    cells.push({ weekStart: w, lane: 'claude-ai', usd: 50.03 })
    cells.push({ weekStart: w, lane: 'claude-cowork', usd: 25.07 })
    cells.push({ weekStart: w, lane: 'claude-office', usd: 10.11 })
    // Two small lanes → the remainder.
    cells.push({ weekStart: w, lane: 'claude-design', usd: 2.01 })
    cells.push({ weekStart: w, lane: 'claude-slack', usd: 1.02 })
  }
  // The PARTIAL week carries spend too (rendered, never ranked).
  cells.push({ weekStart: '2026-07-06', lane: 'claude', usd: 30.55 })
  cells.push({ weekStart: '2026-07-06', lane: 'claude-design', usd: 500 })
  return cells
}

describe('buildWeeklyLanes — fold + partial-week rules (I1)', () => {
  it('zero-fills the ISO-week axis and flags the partial current week', () => {
    const b = buildWeeklyLanes(makeCells(), { from: FROM, to: TO, today: TODAY })
    expect(b.weeks).toEqual(WEEKS)
    expect(b.inProgressWeek).toBe('2026-07-06')
  })

  it('CONSERVATION: Σ(rendered series, incl. partial week) == Σ(input cells), cent-exact', () => {
    const cells = makeCells()
    const b = buildWeeklyLanes(cells, { from: FROM, to: TO, today: TODAY })
    const rendered = b.series.reduce((a, s) => a + s.data.reduce((x, p) => x + p.y, 0), 0)
    const input = cells.reduce((a, c) => a + c.usd, 0)
    expect(cents(rendered)).toBe(cents(input))
    expect(cents(b.totalUsd)).toBe(cents(input))
    // Per-week conservation too: Σ series at each x == Σ cells for that week.
    for (const [wi, w] of b.weeks.entries()) {
      const seriesSum = b.series.reduce((a, s) => a + (s.data[wi]?.y ?? 0), 0)
      const cellSum = cells.filter((c) => c.weekStart === w).reduce((a, c) => a + c.usd, 0)
      expect(cents(seriesSum)).toBe(cents(cellSum))
    }
  })

  it('folds to ≤ MAX_CHART_LANES series; membership ranks on COMPLETE weeks only (r1-F4)', () => {
    const b = buildWeeklyLanes(makeCells(), { from: FROM, to: TO, today: TODAY })
    expect(b.series.length).toBeLessThanOrEqual(MAX_CHART_LANES)
    // claude-design's $500 sits ONLY in the partial week — if the partial week
    // polluted the ranking it would out-rank every non-claude lane. It must fold.
    expect(b.laneIds).toEqual(['claude', 'claude-ai', 'claude-cowork', 'claude-office', FOLDED_LANE_ID])
    expect(b.folded.map((f) => f.lane).sort()).toEqual(['claude-design', 'claude-slack'])
    // The folded disclosure totals are WHOLE-window (incl. the partial week's $500).
    const design = b.folded.find((f) => f.lane === 'claude-design')!
    expect(cents(design.total)).toBe(cents(2.01 * 9 + 500))
  })

  it('renders the partial week INSIDE the bars (the remainder carries its $500)', () => {
    const b = buildWeeklyLanes(makeCells(), { from: FROM, to: TO, today: TODAY })
    const remainder = b.series.find((s) => s.key === FOLDED_LANE_ID)!
    const partialIdx = b.weeks.indexOf('2026-07-06')
    expect(cents(remainder.data[partialIdx]!.y)).toBe(cents(500))
    // r2-1 disclosure: the remainder's per-week composition is itemised.
    expect(b.remainderByWeek['2026-07-06']).toEqual([
      { lane: 'claude-design', label: 'Claude Design', usd: 500 },
    ])
    expect(b.remainderByWeek['2026-05-04']).toEqual([
      { lane: 'claude-design', label: 'Claude Design', usd: 2.01 },
      { lane: 'claude-slack', label: 'Claude in Slack', usd: 1.02 },
    ])
  })

  it('share band: each data week sums to EXACTLY 100.00 (allocate-cents, not naive rounding)', () => {
    const b = buildWeeklyLanes(makeCells(), { from: FROM, to: TO, today: TODAY })
    for (const [wi, w] of b.weeks.entries()) {
      const shares = b.shareSeries.map((s) => s.data[wi]!.y)
      const weekHasData = b.series.some((s) => (s.data[wi]?.y ?? 0) !== 0)
      const sum = shares.reduce((a, v) => a + v, 0)
      if (weekHasData) {
        // 2-dp share units summing to exactly 100.00 — the ±cent-rounding rule.
        expect(Math.round(sum * 100), `week ${w}`).toBe(100_00)
      } else {
        expect(sum).toBe(0)
      }
      for (const v of shares) expect(cents(v)).toBe(cents(Number(v.toFixed(2))))
    }
  })

  it('no fold when the lane count fits; empty input renders an empty (but axed) window', () => {
    const cells: WeeklyLaneCell[] = [
      { weekStart: '2026-05-04', lane: 'claude', usd: 3.33 },
      { weekStart: '2026-05-11', lane: 'claude-ai', usd: 1.11 },
    ]
    const b = buildWeeklyLanes(cells, { from: FROM, to: TO, today: TODAY })
    expect(b.laneIds).toEqual(['claude', 'claude-ai'])
    expect(b.folded).toEqual([])
    const empty = buildWeeklyLanes([], { from: FROM, to: TO, today: TODAY })
    expect(empty.weeks).toEqual(WEEKS)
    expect(empty.series).toEqual([])
    expect(empty.totalUsd).toBe(0)
  })
})

describe('computeCompositionDelta — UNFOLDED basis, complete-4 vs prior-4 (r1-F5)', () => {
  it('recomputes the delta independently from the raw rows', () => {
    const cells = makeCells()
    const b = buildWeeklyLanes(cells, { from: FROM, to: TO, today: TODAY })
    // Independent recomputation from the RAW cells (never the folded series):
    const last4 = new Set(COMPLETE.slice(-4))
    const prior4 = new Set(COMPLETE.slice(-8, -4))
    const sum = (weeks: Set<string>, pred: (c: WeeklyLaneCell) => boolean) =>
      cells.filter((c) => weeks.has(c.weekStart) && pred(c)).reduce((a, c) => a + c.usd, 0)
    const last4NonCode = sum(last4, (c) => c.lane !== 'claude')
    const prior4NonCode = sum(prior4, (c) => c.lane !== 'claude')
    const last4Total = sum(last4, () => true)
    const prior4Total = sum(prior4, () => true)

    const d = b.delta!
    expect(d.nonCodeAvgWeekUsd).toBeCloseTo(last4NonCode / 4, 10)
    expect(d.nonCodeMomPct).toBeCloseTo((last4NonCode - prior4NonCode) / prior4NonCode, 10)
    expect(d.nonCodeSharePct).toBeCloseTo(last4NonCode / last4Total, 10)
    expect(d.nonCodeShareDeltaPts).toBeCloseTo(
      last4NonCode / last4Total - prior4NonCode / prior4Total,
      10,
    )
  })

  it('the PARTIAL week never enters the delta (r1-F4)', () => {
    const base = makeCells().filter((c) => c.weekStart !== '2026-07-06')
    const withPartial = [
      ...base,
      // A massive partial-week non-Code spike must NOT move the delta.
      { weekStart: '2026-07-06', lane: 'claude-ai', usd: 9_999.99 },
    ]
    const a = buildWeeklyLanes(base, { from: FROM, to: TO, today: TODAY }).delta
    const b = buildWeeklyLanes(withPartial, { from: FROM, to: TO, today: TODAY }).delta
    expect(b).toEqual(a)
  })

  it('withholds the delta below 8 complete weeks (no honest MoM exists)', () => {
    const cells = COMPLETE.slice(0, 5).map((w) => ({ weekStart: w, lane: 'claude', usd: 10 }))
    expect(
      computeCompositionDelta(cells, COMPLETE.slice(0, 5)),
    ).toBeNull()
    // And via the builder over a short window (4 complete weeks + partial).
    const short = buildWeeklyLanes(cells, { from: '2026-06-08', to: TO, today: TODAY })
    expect(short.delta).toBeNull()
  })
})

describe('weekly regrouping — the I4 grain-conservation test', () => {
  it('mondayOf matches Postgres date_trunc(week) Mondays', () => {
    expect(mondayOf('2026-07-01')).toBe('2026-06-29') // Wednesday → its Monday
    expect(mondayOf('2026-07-06')).toBe('2026-07-06') // Monday → itself
    expect(mondayOf('2026-07-12')).toBe('2026-07-06') // Sunday → the preceding Monday
  })

  it('weekly Σ == daily Σ for the same window, cent-exact (buildChargebackLaneTrendWeekly)', () => {
    const daily = [
      { day: '2026-07-01', lane: 'claude', chargeUsd: 12.34 },
      { day: '2026-07-02', lane: 'claude', chargeUsd: 1.11 },
      { day: '2026-07-02', lane: 'claude-ai', chargeUsd: 5.55 },
      { day: '2026-07-07', lane: 'claude', chargeUsd: 7.89 },
    ]
    const totalSeries = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06', '2026-07-07']
      .map((day) => ({
        day,
        chargeUsd: daily.filter((p) => p.day === day).reduce((a, p) => a + p.chargeUsd, 0),
      }))
    const weekly = buildChargebackLaneTrendWeekly(daily, totalSeries, TODAY)
    const weeklySum = weekly.series.reduce((a, s) => a + s.data.reduce((x, p) => x + p.y, 0), 0)
    const dailySum = daily.reduce((a, p) => a + p.chargeUsd, 0)
    expect(cents(weeklySum)).toBe(cents(dailySum))
    // Grouped onto the right Mondays.
    const cellsByWeek = groupLaneDaysToWeeks(daily)
    expect(new Set(cellsByWeek.map((c) => c.weekStart))).toEqual(new Set(['2026-06-29', '2026-07-06']))
    // The axis derives from the zero-filled daily total series' span.
    expect(weekly.weeks).toEqual(['2026-06-29', '2026-07-06'])
    // 2026-07-06 is the week containing `today` → flagged in progress.
    expect(weekly.inProgressWeek).toBe('2026-07-06')
  })
})

describe('computePeakDay — the chip binds to the chart’s OWN day series (r2-3)', () => {
  const series = [
    {
      data: [
        { x: '2026-07-01', y: 10 },
        { x: '2026-07-02', y: 90.5 },
        { x: '2026-07-03', y: 40 },
      ],
    },
    {
      data: [
        { x: '2026-07-01', y: 5 },
        { x: '2026-07-02', y: 9.5 },
        { x: '2026-07-03', y: 60 },
      ],
    },
  ]

  it('returns the max SUMMED day across the same series the chart stacks', () => {
    // 07-01: 15 · 07-02: 100 · 07-03: 100 → tie resolves to the EARLIEST day.
    expect(computePeakDay(series)).toEqual({ day: '2026-07-02', totalUsd: 100 })
  })

  it('excludes projected days (a run-rate guess never wins the chip)', () => {
    const withTail = [
      { data: [...series[0]!.data, { x: '2026-07-04', y: 500 }] },
      series[1]!,
    ]
    expect(computePeakDay(withTail, { excludeFrom: '2026-07-04' })).toEqual({
      day: '2026-07-02',
      totalUsd: 100,
    })
  })

  it('null when nothing positive renders', () => {
    expect(computePeakDay([{ data: [{ x: '2026-07-01', y: 0 }] }])).toBeNull()
    expect(computePeakDay([])).toBeNull()
  })
})
