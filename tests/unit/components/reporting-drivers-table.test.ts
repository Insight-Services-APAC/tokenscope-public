// @vitest-environment happy-dom
/*
 * DriversTable — the spend-class-aware breakdown. The load-bearing invariants:
 *  - the sum-back check row goes RED when Σ(rows) ≠ headline (drivers must
 *    reconcile in the same lane);
 *  - any `pooled-usage` row FORCES the informational footer (Copilot per-seat
 *    share is never a charge, owner-decisions D-Q6);
 *  - `drill` / `update:axis` emit contracts.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DriversTable from '../../../app/components/reporting/DriversTable.vue'
import type { DriverRow } from '#shared/reports/types'

const AXES = [
  { value: 'teammate', label: 'By teammate' },
  { value: 'model', label: 'By model' },
]

function rows(): DriverRow[] {
  return [
    { key: 'a', label: 'Ada', usd: 60, sharePct: 0.6, spendClass: 'estimated' },
    { key: 'b', label: 'Grace', usd: 40, sharePct: 0.4, spendClass: 'estimated' },
  ]
}

function mountTable(overrides = {}) {
  return mount(DriversTable, {
    props: {
      rows: rows(),
      headlineUsd: 100,
      axis: 'teammate',
      axisOptions: AXES,
      denominatorLabel: 'region usage',
      ...overrides,
    },
  })
}

describe('DriversTable sum-back check row', () => {
  it('reconciles (not red) when Σ(rows) equals the headline', () => {
    const w = mountTable({ headlineUsd: 100 })
    const sumback = w.find('[data-testid="drivers-sumback"]')
    expect(sumback.attributes('data-mismatch')).toBe('false')
    expect(sumback.classes()).not.toContain('text-rag-red')
    expect(sumback.text()).toContain('reconciles to headline')
  })

  it('goes RED when Σ(rows) ≠ the headline', () => {
    const w = mountTable({ headlineUsd: 90 })
    const sumback = w.find('[data-testid="drivers-sumback"]')
    expect(sumback.attributes('data-mismatch')).toBe('true')
    expect(sumback.classes()).toContain('text-rag-red')
    expect(sumback.text()).toContain('does not reconcile')
  })
})

describe('DriversTable pooled-usage footer', () => {
  it('is absent when no pooled-usage row and no pooledFooter', () => {
    const w = mountTable()
    expect(w.find('[data-testid="drivers-pooled-footer"]').exists()).toBe(false)
  })

  it('is FORCED with the exact copy on any pooled-usage row', () => {
    const pooled: DriverRow[] = [
      { key: 'a', label: 'Ada', usd: 60, sharePct: 0.6, spendClass: 'pooled-usage' },
      { key: 'b', label: 'Grace', usd: 40, sharePct: 0.4, spendClass: 'estimated' },
    ]
    const w = mountTable({ rows: pooled })
    const footer = w.find('[data-testid="drivers-pooled-footer"]')
    expect(footer.exists()).toBe(true)
    expect(footer.text()).toBe('per-seat share is informational — billing is pooled')
  })

  it('renders pooledFooter override when supplied and no pooled row', () => {
    const w = mountTable({ pooledFooter: 'chargeable only' })
    expect(w.find('[data-testid="drivers-pooled-footer"]').text()).toBe('chargeable only')
  })
})

describe('DriversTable estimated spend-class treatment', () => {
  it('mutes + badges estimated rows (advisory, not a billed charge — shared/reports/types)', () => {
    // The default rows are both spendClass 'estimated'.
    const w = mountTable()
    // Each estimated spend cell is muted (italic / carbon-3) and titled as informational —
    // it must NOT render identical to a hard billed charge.
    const informational = w.findAll('td[title="informational — not a charge"]')
    expect(informational.length).toBe(2)
    for (const c of informational) {
      expect(c.classes()).toContain('italic')
      expect(c.classes()).toContain('text-carbon-3')
    }
    // Each estimated row carries an "estimated" badge.
    expect(w.find('tbody').text()).toContain('estimated')
  })

  it('does NOT force the pooled footer for estimated rows (only pooled-usage does)', () => {
    const w = mountTable() // estimated rows, no pooledFooter
    expect(w.find('[data-testid="drivers-pooled-footer"]').exists()).toBe(false)
  })
})

describe('DriversTable emits', () => {
  it('emits drill with the row when a driver label is activated', async () => {
    const w = mountTable()
    await w.findAll('[data-testid="drivers-drill"]')[0]!.trigger('click')
    expect(w.emitted('drill')?.[0]?.[0]).toMatchObject({ key: 'a', label: 'Ada' })
  })

  it('emits update:axis when the axis selector changes', async () => {
    const w = mountTable()
    await w.find('[data-testid="drivers-axis"]').setValue('model')
    expect(w.emitted('update:axis')?.[0]).toEqual(['model'])
  })
})
