// @vitest-environment happy-dom
/*
 * #585: the Region report's hints only point to pages the viewer can open.
 *
 * - The chargeback card says "Per-teammate detail lives in Finance" only to a
 *   reader who holds the Finance report scope (most viewers have no Finance tab).
 * - The practice ranking's unplaced bucket links to the region's placement list
 *   only for an admin who can open it; everyone else reads plain words.
 * Both components fail closed: without the flags, no hint and no link.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RegionalChargebackRank from '../../../app/components/reporting/regional/RegionalChargebackRank.vue'
import RegionalPracticeRank from '../../../app/components/reporting/regional/RegionalPracticeRank.vue'

const global = {
  stubs: {
    NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
    LaneSwitchLink: true,
    ClientOnly: { template: '<div><slot /></div>' },
    VChart: true,
    ChartRankedBar: true,
  },
}

const chargebackRows = [{ key: 'ou-1', label: 'Cloud', value: 120 }]
const practices = [
  { key: 'ou-1', label: 'Cloud', value: 80, spendClass: 'indicative' as const, isDefault: false },
  { key: 'ou-def', label: 'APAC (default)', value: 40, spendClass: 'indicative' as const, isDefault: true },
]
const PLACE = '/admin/regions/9a1e0000-0000-4000-8000-000000000585?tab=teammates&placement=unplaced'

describe('RegionalChargebackRank: the Finance sentence (#585)', () => {
  it('a manager without Finance does not see it', () => {
    const w = mount(RegionalChargebackRank, { props: { rows: chargebackRows }, global })
    expect(w.find('[data-testid="regional-chargeback-finance-hint"]').exists()).toBe(false)
    expect(w.text()).not.toContain('Finance')
  })

  it('a reader with the Finance scope does', () => {
    const w = mount(RegionalChargebackRank, { props: { rows: chargebackRows, canSeeFinance: true }, global })
    expect(w.get('[data-testid="regional-chargeback-finance-hint"]').text()).toBe('Per-teammate detail lives in Finance.')
  })
})

describe('RegionalPracticeRank: the unplaced bucket (#585)', () => {
  it('a non-admin reads plain words and gets no link', () => {
    const w = mount(RegionalPracticeRank, { props: { practices }, global })
    expect(w.find('[data-testid="regional-practice-place-link"]').exists()).toBe(false)
    expect(w.get('[data-testid="regional-practice-unplaced-note"]').text()).toBe('not yet placed in a Business Unit')
    expect(w.text()).not.toMatch(/place these teammates/i)
  })

  it('an admin gets a link to the region Teammates tab filtered to unplaced', () => {
    const w = mount(RegionalPracticeRank, { props: { practices, placementHref: PLACE }, global })
    const link = w.get('[data-testid="regional-practice-place-link"]')
    expect(link.attributes('href')).toBe(PLACE)
    expect(link.text()).toContain('place these teammates')
    expect(w.find('[data-testid="regional-practice-unplaced-note"]').exists()).toBe(false)
  })
})
