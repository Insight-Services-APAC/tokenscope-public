/*
 * build-chargeback-trend — the pure §B chargeback-lane builders (lane-visuals V2).
 * Pins:
 *   - lane series align to the zero-filled TOTAL axis and conserve per day
 *     (Σ lane values per day == chargeSeries[day]);
 *   - the run-rate tail projects the TOTAL only (dashed continuation), anchored
 *     on the §B series' own as-of day — no §A operand;
 *   - no tail in range mode (month null) or when the month has fully accrued;
 *   - the donut caps at MAX_CHART_LANES slices + fold, EXCLUDES
 *     copilot-unclassified from the slices and the chargeable sum, and surfaces
 *     it for its badge; a NEGATIVE lane NETS IN (r3-2), never silently drops;
 *   - trend and donut fold with the SAME cap → identical kept-lane sets (r3-3);
 *   - the page-legend union is canonical-ordered with the remainder last.
 */
import { describe, it, expect } from 'vitest'
import {
  buildChargebackLaneTrend,
  buildChargebackDonut,
  chargebackLegendLanes,
} from '../../../app/components/reporting/build-chargeback-trend'
import { FOLDED_LANE_ID, MAX_CHART_LANES } from '../../../app/components/reporting/charts/fold-lanes'
import type { ChargeDailyPoint, ChargeLanePoint } from '../../../shared/reports/types'

/** Zero-filled July 1-10 totals: charge on the 2nd (6) and 3rd (9), rest 0. */
const totals: ChargeDailyPoint[] = Array.from({ length: 10 }, (_, i) => {
  const day = `2026-07-${String(i + 1).padStart(2, '0')}`
  const chargeUsd = day === '2026-07-02' ? 6 : day === '2026-07-03' ? 9 : 0
  return { day, chargeUsd }
})

const lanes: ChargeLanePoint[] = [
  { day: '2026-07-02', lane: 'claude', chargeUsd: 4 },
  { day: '2026-07-02', lane: 'claude-ai', chargeUsd: 2 },
  { day: '2026-07-03', lane: 'claude', chargeUsd: 9 },
]

describe('buildChargebackLaneTrend', () => {
  it('aligns lane series to the zero-filled axis and conserves per day', () => {
    const b = buildChargebackLaneTrend(lanes, totals, null)
    expect(b.series.map((s) => s.key)).toEqual(['claude', 'claude-ai'])
    for (const s of b.series) expect(s.data.map((p) => p.x)).toEqual(totals.map((t) => t.day))
    // Σ lanes per day == the total series (cent-exact conservation).
    totals.forEach((t, i) => {
      const sum = b.series.reduce((a, s) => a + s.data[i]!.y, 0)
      expect(Math.round(sum * 100)).toBe(Math.round(t.chargeUsd * 100))
    })
  })

  it('run-rate tail: TOTAL only, anchored on the §B as-of day, projected to month-end', () => {
    const b = buildChargebackLaneTrend(lanes, totals, '2026-07')
    // as-of = July 3 (last day with charge > 0); MTD = 15 over 3 days ⇒ $5/day.
    expect(b.forecastFrom).toBe('2026-07-04')
    expect(b.totalTail[0]).toEqual({ x: '2026-07-03', y: 9 }) // connects at the actual total
    expect(b.totalTail).toHaveLength(1 + 28) // as-of + July 4..31
    expect(b.totalTail.at(-1)!.x).toBe('2026-07-31')
    for (const p of b.totalTail.slice(1)) expect(p.y).toBeCloseTo(5, 9)
    // The tail is a TOTAL annotation — lane series carry no projected days.
    for (const s of b.series) expect(s.data.at(-1)!.x).toBe('2026-07-10')
  })

  it('no tail in range mode (month null) or when the month has fully accrued', () => {
    expect(buildChargebackLaneTrend(lanes, totals, null).totalTail).toEqual([])
    const fullMonth: ChargeDailyPoint[] = Array.from({ length: 31 }, (_, i) => ({
      day: `2026-07-${String(i + 1).padStart(2, '0')}`,
      chargeUsd: 1,
    }))
    const full = buildChargebackLaneTrend(
      fullMonth.map((p) => ({ day: p.day, lane: 'claude', chargeUsd: 1 })),
      fullMonth,
      '2026-07',
    )
    expect(full.totalTail).toEqual([])
    expect(full.forecastFrom).toBeUndefined()
  })

  it('folds beyond MAX_CHART_LANES lanes into the single remainder, conservation preserved', () => {
    const manyLanes: ChargeLanePoint[] = [
      { day: '2026-07-02', lane: 'claude', chargeUsd: 100 },
      { day: '2026-07-02', lane: 'claude-ai', chargeUsd: 90 },
      { day: '2026-07-02', lane: 'claude-cowork', chargeUsd: 80 },
      { day: '2026-07-02', lane: 'claude-office', chargeUsd: 70 },
      { day: '2026-07-02', lane: 'claude-chrome', chargeUsd: 60 },
      { day: '2026-07-02', lane: 'claude-design', chargeUsd: 50 },
      { day: '2026-07-02', lane: 'claude-slack', chargeUsd: 2 },
      { day: '2026-07-02', lane: 'claude-other', chargeUsd: 1 },
    ]
    const manyTotals: ChargeDailyPoint[] = [{ day: '2026-07-02', chargeUsd: 453 }]
    const b = buildChargebackLaneTrend(manyLanes, manyTotals, null)
    // The SHARED page cap (r3-3): the trend folds at MAX_CHART_LANES, exactly
    // like the sibling donut — never its own private ceiling.
    expect(b.series).toHaveLength(MAX_CHART_LANES)
    expect(b.series.at(-1)!.key).toBe(FOLDED_LANE_ID)
    const sum = b.series.reduce((a, s) => a + s.data[0]!.y, 0)
    expect(Math.round(sum * 100)).toBe(45300)
    // 8 lanes → keep the top (MAX_CHART_LANES − 1) by window total + ONE remainder.
    expect(b.folded.map((f) => f.lane)).toEqual([
      'claude-chrome',
      'claude-design',
      'claude-slack',
      'claude-other',
    ])
  })
})

describe('buildChargebackDonut', () => {
  const rows = [
    { lane: 'claude', chargeUsd: 10 },
    { lane: 'claude-ai', chargeUsd: 2 },
    { lane: 'copilot-license', chargeUsd: 100 },
    { lane: 'copilot-usage', chargeUsd: 20 },
    { lane: 'copilot-unclassified', chargeUsd: 7 },
  ]

  it('excludes copilot-unclassified from slices AND the chargeable sum; surfaces it for the badge', () => {
    const d = buildChargebackDonut(rows)
    expect(d.slices.map((s) => s.lane)).toEqual(['claude', 'claude-ai', 'copilot-license', 'copilot-usage'])
    expect(Math.round(d.chargeableUsd * 100)).toBe(13200) // 132 — never 139
    expect(d.unclassifiedUsd).toBe(7)
    expect(d.laneIds).not.toContain('copilot-unclassified')
  })

  it('caps at MAX_CHART_LANES slices with the folded remainder, Σ slices == chargeable', () => {
    const many = [
      { lane: 'claude', chargeUsd: 50 },
      { lane: 'claude-ai', chargeUsd: 40 },
      { lane: 'claude-cowork', chargeUsd: 30 },
      { lane: 'claude-office', chargeUsd: 20 },
      { lane: 'claude-chrome', chargeUsd: 10 },
      { lane: 'claude-design', chargeUsd: 5 },
      { lane: 'claude-slack', chargeUsd: 1 },
    ]
    const d = buildChargebackDonut(many)
    expect(d.slices).toHaveLength(MAX_CHART_LANES)
    expect(d.slices.at(-1)!.lane).toBe(FOLDED_LANE_ID)
    const sum = d.slices.reduce((a, s) => a + s.value, 0)
    expect(Math.round(sum * 100)).toBe(Math.round(d.chargeableUsd * 100))
    expect(d.folded.map((f) => f.lane)).toEqual(['claude-chrome', 'claude-design', 'claude-slack'])
  })

  it('elides zero-amount lanes (the pool view emits rows regardless of amount)', () => {
    const d = buildChargebackDonut([
      { lane: 'claude', chargeUsd: 10 },
      { lane: 'copilot-license', chargeUsd: 0 },
    ])
    expect(d.slices.map((s) => s.lane)).toEqual(['claude'])
  })

  it('a NEGATIVE lane (credit/refund month) NETS IN — Σ slices == chargeableUsd, cent-exact (r3-2)', () => {
    const d = buildChargebackDonut([
      { lane: 'claude', chargeUsd: 100 },
      { lane: 'claude-ai', chargeUsd: -12.34 },
      { lane: 'copilot-license', chargeUsd: 20 },
    ])
    // The negative lane is a SLICE (never dropped) and the chargeable sum nets it.
    expect(d.slices.map((s) => s.lane)).toEqual(['claude', 'claude-ai', 'copilot-license'])
    expect(Math.round(d.chargeableUsd * 100)).toBe(Math.round((100 - 12.34 + 20) * 100))
    const sum = d.slices.reduce((a, s) => a + s.value, 0)
    expect(Math.round(sum * 100)).toBe(Math.round(d.chargeableUsd * 100))
  })
})

describe('fold-cap consistency (r3-3): trend and donut keep the SAME lane set', () => {
  it('the same per-lane totals fold to the same kept-lane membership in both builders', () => {
    // 7 lanes on one day — beyond the cap in BOTH builders, so both must fold,
    // and the kept set must be identical (one page legend, atomic identity).
    const day = '2026-07-02'
    const laneTotals: Array<[string, number]> = [
      ['claude', 50],
      ['claude-ai', 40],
      ['claude-cowork', 30],
      ['claude-office', 20],
      ['claude-chrome', 10],
      ['claude-design', 5],
      ['claude-slack', 1],
    ]
    const trend = buildChargebackLaneTrend(
      laneTotals.map(([lane, usd]) => ({ day, lane, chargeUsd: usd })),
      [{ day, chargeUsd: laneTotals.reduce((a, [, v]) => a + v, 0) }],
      null,
    )
    const donut = buildChargebackDonut(laneTotals.map(([lane, usd]) => ({ lane, chargeUsd: usd })))
    // Identical kept sets (incl. the remainder as the single last entry) —
    // a lane is either its own colour in EVERY card or folded in EVERY card.
    expect(trend.laneIds).toEqual(donut.laneIds)
    expect(trend.folded.map((f) => f.lane)).toEqual(donut.folded.map((f) => f.lane))
  })
})

describe('chargebackLegendLanes', () => {
  it('unions lane sets in canonical order with the remainder last', () => {
    const entries = chargebackLegendLanes([
      ['claude-ai', FOLDED_LANE_ID],
      ['claude', 'copilot-license'],
    ])
    expect(entries.map((e) => e.lane)).toEqual(['claude', 'claude-ai', 'copilot-license', FOLDED_LANE_ID])
    expect(entries.map((e) => e.label)).toEqual([
      'Claude Code',
      'Claude Chat',
      'Copilot License',
      'Other surfaces',
    ])
  })
})
