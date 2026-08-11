// @vitest-environment happy-dom
/*
 * PlacementRuleOffer — WHICH rule it offers, which is the part that can quietly
 * do damage.
 *
 * The offer is what turns a one-off clean-up into something durable, but a rule
 * inferred from the wrong attribute routes far more people than the admin meant:
 * a batch that shares a department almost always shares a company name too, and
 * "companyName = Insight Australia ⇒ EMEA Solutions Core" sends the entire legal
 * entity to one cost centre. So the cases below are about the candidate set:
 * only attributes EVERY placed teammate agrees on, only ones we actually have a
 * value for, and the narrowest one pre-selected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import PlacementRuleOffer from '../../../app/components/admin/PlacementRuleOffer.vue'

const ROWS = [
  { id: 'a', department: 'Sales-Solution', company_name: 'Insight EMEA' },
  { id: 'b', department: 'Sales-Solution', company_name: 'Insight EMEA' },
  // NOT in the batch: a different department, to prove the offer is computed
  // from the ids that were placed and not from whatever the table is showing.
  { id: 'z', department: 'Delivery', company_name: 'Insight EMEA' },
]

function mountOffer(props: Partial<InstanceType<typeof PlacementRuleOffer>['$props']> = {}) {
  return mount(PlacementRuleOffer, {
    props: {
      teammateIds: ['a', 'b'],
      rows: ROWS,
      orgUnitId: 'ou-core',
      orgUnitName: 'EMEA Solutions Core',
      ...props,
    },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('PlacementRuleOffer — which rule it offers', () => {
  it('offers every attribute the BATCH agrees on, and pre-selects the narrowest', () => {
    const w = mountOffer()
    expect(w.find('[data-testid="placement-rule-offer"]').exists()).toBe(true)
    expect(w.find('[data-testid="rule-offer-option-department"]').exists()).toBe(true)
    expect(w.find('[data-testid="rule-offer-option-companyName"]').exists()).toBe(true)
    // Department is the narrowest signal the batch shares, so it is the default:
    // a company-name rule would route the whole entity into this cost centre.
    const checked = w.findAll('input[type="radio"]').filter((i) => (i.element as HTMLInputElement).checked)
    expect(checked).toHaveLength(1)
    expect(checked[0]!.attributes('value')).toBe('department')
  })

  it('does not offer an attribute the batch DISAGREES on', () => {
    // Adding `z` to the batch breaks the department agreement but not the company.
    const w = mountOffer({ teammateIds: ['a', 'b', 'z'] })
    expect(w.find('[data-testid="rule-offer-option-department"]').exists()).toBe(false)
    expect(w.find('[data-testid="rule-offer-option-companyName"]').exists()).toBe(true)
  })

  it('does not offer an attribute nobody has a value for — a rule from no reading is a guess', () => {
    const w = mountOffer({
      rows: [
        { id: 'a', department: 'Sales-Solution', company_name: null },
        { id: 'b', department: 'Sales-Solution', company_name: '   ' },
      ],
    })
    expect(w.find('[data-testid="rule-offer-option-department"]').exists()).toBe(true)
    expect(w.find('[data-testid="rule-offer-option-companyName"]').exists()).toBe(false)
  })

  it('does not offer an attribute only SOME of the batch has a value for', () => {
    // A partial reading is not agreement: the ones we have no value for might
    // carry a different one, and a rule built on that assumption routes them
    // somewhere nobody chose.
    const w = mountOffer({
      rows: [
        { id: 'a', department: 'Sales-Solution', company_name: 'Insight EMEA' },
        { id: 'b', department: 'Sales-Solution', company_name: null },
      ],
    })
    expect(w.find('[data-testid="rule-offer-option-department"]').exists()).toBe(true)
    expect(w.find('[data-testid="rule-offer-option-companyName"]').exists()).toBe(false)
  })

  it('offers nothing at all when the batch shares nothing', () => {
    const w = mountOffer({
      rows: [
        { id: 'a', department: 'Sales', company_name: 'X' },
        { id: 'b', department: 'Delivery', company_name: 'Y' },
      ],
    })
    expect(w.find('[data-testid="placement-rule-offer"]').exists()).toBe(false)
  })

  it('posts a UNIT rule for the chosen attribute — never a region rule', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ id: 'rule-1' })
    vi.stubGlobal('$fetch', fetchSpy)
    const w = mountOffer()
    await w.find('[data-testid="rule-offer-create"]').trigger('click')
    await flushPromises()

    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/admin/directory-region-rules', {
      method: 'POST',
      body: {
        attribute: 'department',
        match_mode: 'exact',
        // The value as the directory spells it — the server normalises it with
        // the same normaliser the matcher uses.
        match_value: 'Sales-Solution',
        org_unit_id: 'ou-core',
      },
    })
    expect(w.emitted('created')).toEqual([[{ attribute: 'department', value: 'Sales-Solution' }]])
  })

  /*
   * THE PRECEDENCE MISMATCH. The offer prefers the NARROWEST attribute; the engine
   * resolves BROAD-first (mapAttributesToRegion walks the catalog in order and the
   * first attribute with a matching rule decides). So an existing companyName rule
   * beats the department rule the offer just pre-selected, and the panel's promise
   * — "the next person with that value lands in EMEA Solutions Core" — is one the
   * engine will not keep.
   */
  describe('when an existing higher-precedence rule already decides the batch', () => {
    const COMPANY_RULE = {
      attribute: 'companyName',
      match_mode: 'exact',
      match_value: 'insight emea',
      match_value_raw: 'Insight EMEA',
      org_unit_id: 'ou-elsewhere',
      org_unit_display_name: 'EMEA Delivery',
    }

    it('warns, names the rule that wins, and does not pre-select the shadowed one', async () => {
      const w = mountOffer({ existingRules: [COMPANY_RULE] })
      const checked = w.findAll('input[type="radio"]').filter((i) => (i.element as HTMLInputElement).checked)
      // companyName is the one the engine would honour, so it is the default —
      // NOT department, which would silently do nothing for these people.
      expect(checked[0]!.attributes('value')).toBe('companyName')

      await w.find('[data-testid="rule-offer-option-department"]').find('input').setValue()
      const warning = w.find('[data-testid="rule-offer-shadow"]')
      expect(warning.exists()).toBe(true)
      expect(warning.text()).toContain('Insight EMEA')
      expect(warning.text()).toContain('EMEA Delivery')
      // Both placed teammates carry that company value.
      expect(warning.text()).toContain('2 of the 2')
    })

    it('is not a shadow when the existing rule points at the SAME cost centre', () => {
      const w = mountOffer({
        existingRules: [{ ...COMPANY_RULE, org_unit_id: 'ou-core', org_unit_display_name: 'EMEA Solutions Core' }],
      })
      // The outcome the offer promises still happens, so there is nothing to warn
      // about and the narrowest default stands.
      const checked = w.findAll('input[type="radio"]').filter((i) => (i.element as HTMLInputElement).checked)
      expect(checked[0]!.attributes('value')).toBe('department')
      expect(w.find('[data-testid="rule-offer-shadow"]').exists()).toBe(false)
    })

    it('a rule on a LOWER-precedence attribute does not shadow anything', () => {
      const w = mountOffer({
        existingRules: [{
          attribute: 'department', match_mode: 'exact', match_value: 'sales-solution',
          match_value_raw: 'Sales-Solution', org_unit_id: 'ou-elsewhere', org_unit_display_name: 'EMEA Delivery',
        }],
      })
      // department cannot beat itself, and nothing broader matches — the narrowest
      // default stands and no warning is claimed.
      const checked = w.findAll('input[type="radio"]').filter((i) => (i.element as HTMLInputElement).checked)
      expect(checked[0]!.attributes('value')).toBe('department')
      expect(w.find('[data-testid="rule-offer-shadow"]').exists()).toBe(false)
    })

    it('a PREFIX rule on a broader attribute shadows too — the matcher scans prefixes', async () => {
      const w = mountOffer({
        existingRules: [{
          attribute: 'companyName', match_mode: 'prefix', match_value: 'insight ',
          match_value_raw: 'Insight ', org_unit_id: 'ou-elsewhere', org_unit_display_name: 'EMEA Delivery',
        }],
      })
      // The default moves off the shadowed department, exactly as for an exact
      // rule — a prefix rule the batch matches decides them just as firmly.
      const checked = w.findAll('input[type="radio"]').filter((i) => (i.element as HTMLInputElement).checked)
      expect(checked[0]!.attributes('value')).toBe('companyName')
      await w.find('[data-testid="rule-offer-option-department"]').find('input').setValue()
      expect(w.find('[data-testid="rule-offer-shadow"]').text()).toContain('EMEA Delivery')
    })
  })

  it('declining creates nothing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('$fetch', fetchSpy)
    const w = mountOffer()
    await w.find('[data-testid="rule-offer-dismiss"]').trigger('click')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(w.emitted('dismiss')).toHaveLength(1)
  })

  it('a refusal is shown and nothing is claimed to have been created', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({
      statusCode: 403,
      data: { data: { detail: 'Region admin scope does not include this region.' } },
    }))
    const w = mountOffer()
    await w.find('[data-testid="rule-offer-create"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="rule-offer-error"]').text()).toContain('scope does not include')
    expect(w.emitted('created')).toBeUndefined()
  })
})
