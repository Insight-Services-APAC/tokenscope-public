// @vitest-environment happy-dom
/*
 * T14/T15 (component half) — MeHeroTiles (developer-pages W2 D17).
 *
 * The /usage hero is four ScopeKpiTile's (NOT ScopeHero — its prop is a
 * reports shape). Pins:
 *  - per-tile deltas: money keeps the percentage, a count is absolute, and
 *    every delta names its basis;
 *  - the two NAMED deltaEmpty reasons render verbatim (day-1 fixture: "too
 *    early to compare"; custom range: "no month-on-month for a custom range");
 *  - the quota tile in the chargeback lane is "—" WITH its stated reason —
 *    never a silently empty tile (T15);
 *  - a custom range states the quota's month basis the same way;
 *  - the spark has NO floor and spans the whole month (F2/D7): a 3-day series
 *    draws three days and dots the rest, never "not enough days yet".
 *
 * MUTATIONS these pin: swap the delta reasons → the reason tests go red;
 * render the quota tile silently empty → the stated-reason tests go red;
 * put any floor back on the spark → the month-frame test goes red.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MeHeroTiles from '../../../app/components/me/MeHeroTiles.vue'
import type { MeHeroTileWire, MeHeroWindowWire } from '../../../app/components/me/MeHeroTiles.vue'

const monthWindow: MeHeroWindowWire = {
  from: '2026-07-01',
  to: '2026-07-31',
  is_month: true,
  month: '2026-07',
  days_elapsed: 14,
  days_in_month: 31,
  // The sparks run to min(window end, today), so on the in-progress month their
  // last point is today. The SERVER states it — the frame cannot (r2).
  spark_partial: true,
}

const runRate = {
  projected_month_end_usd: '440.00',
  days_elapsed: 14,
  days_in_month: 31,
  method: 'linear-mtd' as const,
  is_projection: true,
}

const quota = {
  total_usd: '500.00',
  base_allowance_usd: '100.00',
  allocation_usd: '400.00',
  projection: { state: 'projected', date: '2026-07-18' } as const,
}

const usageTiles: MeHeroTileWire[] = [
  {
    key: 'attributed',
    value_usd: '198.72',
    delta_pct: 0.12,
    delta_empty_reason: null,
    spark: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    key: 'budgeted',
    value_usd: '120.00',
    budgeted_share_pct: 0.6039,
    no_budget_usd: '54.01',
    untagged_usd: '22.10',
    delta_pct: -0.09,
    delta_empty_reason: null,
    spark: [1, 1, 2, 2, 3, 3, 4, 4],
  },
  { key: 'quota', quota_basis: 'window-month' },
  {
    key: 'active_days',
    count: 9,
    days_so_far: 14,
    delta_abs: 2,
    delta_empty_reason: null,
    spark: [1, 0, 2, 0, 3, 0, 4, 0],
  },
]

function mountTiles(over: {
  tiles?: MeHeroTileWire[]
  window?: MeHeroWindowWire
  lane?: 'usage' | 'chargeback'
  quota?: typeof quota | null
} = {}) {
  return mount(MeHeroTiles, {
    props: {
      tiles: over.tiles ?? usageTiles,
      window: over.window ?? monthWindow,
      lane: over.lane ?? 'usage',
      quota: 'quota' in over ? over.quota! : quota,
      runRate,
      mtdUsd: '198.72',
    },
  })
}

describe('MeHeroTiles — four tiles, each with its OWN delta (T14)', () => {
  it('renders the four usage-lane tiles in order', () => {
    const w = mountTiles()
    const keys = ['attributed', 'budgeted', 'quota', 'active_days']
    for (const k of keys) expect(w.find(`[data-testid="me-tile-${k}"]`).exists()).toBe(true)
    expect(w.findAll('[data-testid="scope-kpi-tile"]')).toHaveLength(4)
  })

  it('a MONEY delta keeps the percentage, with its basis; a COUNT delta is absolute', () => {
    const w = mountTiles()
    const attributed = w.find('[data-testid="me-tile-attributed"]')
    expect(attributed.text()).toContain('$198.72')
    expect(attributed.find('[data-testid="kpi-delta"]').text()).toContain('12%')
    expect(attributed.find('[data-testid="kpi-delta"]').text()).toContain('vs last month')

    const days = w.find('[data-testid="me-tile-active_days"]')
    expect(days.text()).toContain('of 14 so far')
    const delta = days.find('[data-testid="kpi-delta"]').text()
    expect(delta).toContain('2')
    expect(delta).not.toContain('%') // never "↑13% of a headcount"
  })

  it('the budgeted tile spells its three operands out', () => {
    const w = mountTiles()
    const t = w.find('[data-testid="me-tile-budgeted"]').text()
    expect(t).toContain('$120.00')
    expect(t).toContain('on budgeted projects')
    expect(t).toContain('$54.01 no budget')
    expect(t).toContain('$22.10 untagged')
  })

  it('a withheld delta names its reason — both vocabularies verbatim', () => {
    // Day-1: 'too early to compare'.
    const early = usageTiles.map((t) =>
      t.key === 'quota' ? t : { ...t, delta_pct: null, delta_abs: null, delta_empty_reason: 'too early to compare' },
    )
    const w1 = mountTiles({ tiles: early })
    expect(w1.find('[data-testid="me-tile-attributed"] [data-testid="kpi-delta-empty"]').text()).toBe(
      'too early to compare',
    )
    // Custom range: 'no month-on-month for a custom range'.
    const range = usageTiles.map((t) =>
      t.key === 'quota'
        ? { ...t, quota_basis: 'custom-range' as const }
        : { ...t, delta_pct: null, delta_abs: null, delta_empty_reason: 'no month-on-month for a custom range' },
    )
    const w2 = mountTiles({
      tiles: range,
      window: { ...monthWindow, is_month: false, month: null, days_elapsed: null, days_in_month: null },
    })
    expect(w2.find('[data-testid="me-tile-active_days"] [data-testid="kpi-delta-empty"]').text()).toBe(
      'no month-on-month for a custom range',
    )
  })

  /*
   * RED ON REVERT (r2): restore MonthSpark's `partial ?? span > n` inference and
   * drop `:spark-partial` from the tile — the FINISHED case below then draws the
   * still-accruing mark on a completed day (14 points inside a 31-day frame reads
   * as "days to come, so the last one is today"), and the no-flag case invents a
   * claim where the payload made none. The frame is not evidence about the last
   * point; only the server's own statement is.
   */
  it('the spark endpoint is the SERVER\u2019s claim: still filling on the in-progress month', () => {
    const w = mountTiles()
    const end = w
      .find('[data-testid="me-tile-attributed"]')
      .find('[data-testid="month-spark-endpoint"]')
    expect(end.attributes('data-partial')).toBe('true')
  })

  it('a FINISHED window states `false` and draws a solid endpoint', () => {
    const w = mountTiles({ window: { ...monthWindow, spark_partial: false } })
    const end = w
      .find('[data-testid="me-tile-attributed"]')
      .find('[data-testid="month-spark-endpoint"]')
    expect(end.attributes('data-partial')).toBe('false')
    expect(end.attributes('fill')).not.toBe('var(--paper)')
  })

  it('an older payload without the flag makes NO claim — no endpoint marker', () => {
    const noFlag = { ...monthWindow }
    delete (noFlag as { spark_partial?: boolean }).spark_partial
    const w = mountTiles({ window: noFlag })
    const tile = w.find('[data-testid="me-tile-attributed"]')
    expect(tile.find('[data-testid="month-spark-line"]').exists()).toBe(true)
    expect(tile.find('[data-testid="month-spark-endpoint"]').exists()).toBe(false)
  })

  it('the spark has NO floor — three days DRAW, over the month\u2019s own frame (F2/D7)', () => {
    const short = usageTiles.map((t) => (t.spark ? { ...t, spark: [1, 2, 3] } : t))
    const w = mountTiles({ tiles: short })
    const tile = w.find('[data-testid="me-tile-attributed"]')
    expect(tile.find('[data-testid="month-spark-line"]').exists()).toBe(true)
    expect(tile.text()).not.toContain('not enough days yet')
    // 31-day month, 3 elapsed days → 28 days still to come, as baseline dots.
    expect(tile.findAll('[data-testid="month-spark-dot"]')).toHaveLength(28)
  })
})

describe('MeHeroTiles — the quota tile states its basis (T14/T15)', () => {
  it('window-month: run-rate value, quota operands and the exhaustion warning', () => {
    const w = mountTiles()
    const t = w.find('[data-testid="me-tile-quota"]')
    expect(t.text()).toContain('~$440.00') // linear run-rate on the headline
    expect(t.text()).toContain('$500.00') // quota
    expect(t.text()).toContain('$100.00') // allowance
    expect(t.text()).toContain('$400.00') // allocations
    expect(t.text()).toContain('day 14 of 31')
    expect(t.find('[data-testid="quota-exhaustion"]').text()).toContain('~2026-07-18')
    expect(t.find('[data-testid="quota-exhausted"]').exists()).toBe(false)
  })

  it('exhausted quota says the past tense with the overage', () => {
    const w = mountTiles({
      quota: { ...quota, projection: { state: 'exhausted', over_usd: '123.45' } as never },
    })
    const line = w.find('[data-testid="quota-exhausted"]')
    expect(line.exists()).toBe(true)
    expect(line.text()).toContain('is exhausted')
    expect(line.text()).toContain('$123.45')
    expect(w.find('[data-testid="quota-exhaustion"]').exists()).toBe(false)
  })

  it('chargeback lane: "—" WITH the stated reason — never a dead tile (T15)', () => {
    const chargebackTiles: MeHeroTileWire[] = [
      { key: 'chargeable', value_usd: '6.12', delta_pct: null, delta_empty_reason: 'too early to compare' },
      { key: 'attributed', value_usd: '198.72', delta_pct: 0.12, delta_empty_reason: null },
      { key: 'quota', quota_basis: 'window-month' },
      { key: 'active_days', count: 9, days_so_far: 14, delta_abs: null, delta_empty_reason: 'too early to compare' },
    ]
    const w = mountTiles({ tiles: chargebackTiles, lane: 'chargeback', quota: null })
    // Chargeable leads.
    const tiles = w.findAll('[data-testid^="me-tile-"]')
    expect(tiles[0]!.attributes('data-testid')).toBe('me-tile-chargeable')
    expect(tiles[0]!.text()).toContain('$6.12')
    const q = w.find('[data-testid="me-tile-quota"]')
    expect(q.text()).toContain('—')
    expect(q.find('[data-testid="kpi-delta-empty"]').text()).toContain(
      'not shown in the chargeback lens',
    )
    expect(q.find('[data-testid="kpi-delta-empty"]').text()).toContain('attributed usage')
  })

  it('a custom range states the quota’s month basis instead of faking a range quota', () => {
    const tiles = usageTiles.map((t) =>
      t.key === 'quota' ? { ...t, quota_basis: 'custom-range' as const } : t,
    )
    const w = mountTiles({ tiles })
    const q = w.find('[data-testid="me-tile-quota"]')
    expect(q.text()).toContain('—')
    expect(q.find('[data-testid="kpi-delta-empty"]').text()).toContain('calendar-month measure')
  })
})
