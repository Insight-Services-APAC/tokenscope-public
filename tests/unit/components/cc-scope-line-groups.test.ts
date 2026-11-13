/*
 * CcScopeLine (#635): the Business Unit picker is grouped by region when the
 * reader's units span more than one, with their own unit first under "Yours".
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CcScopeLine from '../../../app/components/reporting/cost-centre/CcScopeLine.vue'
import type { CostCentreScope } from '#shared/reports/types'

function scope(options: CostCentreScope['options']): CostCentreScope {
  return { options, defaultCcId: options[0]?.id ?? null, scopeLabel: options[0]?.displayName ?? null } as CostCentreScope
}

const MANY = scope([
  { id: 'a1', displayName: 'Finance', regionCode: 'apac', regionName: 'APAC', owned: false },
  { id: 'a2', displayName: 'Services', regionCode: 'apac', regionName: 'APAC', owned: true },
  { id: 'e1', displayName: 'Finance', regionCode: 'emea', regionName: 'EMEA', owned: false },
  { id: 'n1', displayName: 'Data', regionCode: 'na', regionName: 'North America', owned: false },
])

describe('CcScopeLine groups', () => {
  it('groups by region display name, the reader\'s own unit first under "Yours"', () => {
    const w = mount(CcScopeLine, { props: { scope: MANY, selectedCcId: 'a2' } })
    const groups = w.findAll('optgroup')
    expect(groups.map((g) => g.attributes('label'))).toEqual(['Yours', 'APAC', 'EMEA', 'North America'])
    expect(groups[0]!.findAll('option').map((o) => o.text())).toEqual(['Services'])
    expect(groups[1]!.findAll('option').map((o) => o.text())).toEqual(['Finance'])
    expect(w.text()).not.toContain('(yours)')
  })

  it('choosing a unit still asks the container to rescope', async () => {
    const w = mount(CcScopeLine, { props: { scope: MANY, selectedCcId: 'a2' } })
    await w.find('[data-testid="cc-scope-selector"]').setValue('e1')
    expect(w.emitted('select')).toEqual([['e1']])
  })

  it('units in one region: no group headers', () => {
    const w = mount(CcScopeLine, {
      props: {
        scope: scope([
          { id: 'a1', displayName: 'Finance', regionCode: 'apac', regionName: 'APAC', owned: false },
          { id: 'a2', displayName: 'Services', regionCode: 'apac', regionName: 'APAC', owned: true },
        ]),
      },
    })
    expect(w.findAll('optgroup')).toHaveLength(0)
    expect(w.text()).toContain('Services (yours)')
  })

  it('one unit is still a label, not a control', () => {
    const w = mount(CcScopeLine, {
      props: { scope: scope([{ id: 'a1', displayName: 'Finance', regionCode: 'apac', owned: false }]) },
    })
    expect(w.find('[data-testid="cc-scope-selector"]').exists()).toBe(false)
    expect(w.find('[data-testid="cc-scope-label"]').text()).toBe('Finance')
  })
})
