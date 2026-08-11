// @vitest-environment happy-dom
/*
 * UiRegionSelector — the region width control, against the owner-signed prototype
 * (docs/design/reporting-consolidation/prototype.html, the `across` view's region
 * row).
 *
 * The prototype renders the widths as a PILL ROW with the active one filled:
 *
 *   All regions · APAC · EMEA · North America · Unassigned
 *
 * Dev shipped an HTML `<select>`. This is the same fix already applied to the
 * drivers axis (`note('fix 4')` — chips, not a dropdown); the region selector was
 * missed in that pass, so the page carried two idioms for one kind of choice.
 *
 * WHAT THIS FILE DOES NOT TEST. The option list, its order and the visibility rule
 * are region-options.ts's, and they were already correct — this was a presentation
 * change. Those live in the scope-view suites.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UiRegionSelector from '../../../app/components/ui/RegionSelector.vue'

const options = [
  { id: 'all', code: 'all', displayName: 'All regions' },
  { id: 'r-apac', code: 'apac', displayName: 'APAC' },
  { id: 'r-emea', code: 'emea', displayName: 'EMEA' },
]

const mountSel = (modelValue = 'all') =>
  mount(UiRegionSelector, { props: { modelValue, options } })

/*
 * MUTATION: restore the `<select>`/`<option>` markup — every assertion in this
 * block goes red (`findAll('button')` returns nothing).
 */
describe('UiRegionSelector — pills, not a dropdown', () => {
  it('renders one BUTTON per width, and no select element at all', () => {
    const w = mountSel()
    expect(w.findAll('button').map((b) => b.text())).toEqual(['All regions', 'APAC', 'EMEA'])
    expect(w.find('select').exists()).toBe(false)
    expect(w.find('option').exists()).toBe(false)
  })

  it('emits the chosen width id on click', async () => {
    const w = mountSel()
    await w.findAll('button')[1]!.trigger('click')
    expect(w.emitted('update:modelValue')).toEqual([['r-apac']])
  })
})

/*
 * MUTATION: drop `:aria-pressed` (or hard-code it false) — the active-width
 * assertions go red. An active pill that is only a background colour is invisible
 * to a screen reader, which is the whole reason the drivers chips carry it.
 */
describe('UiRegionSelector — the active width is exposed to assistive tech', () => {
  it('marks exactly ONE pill pressed, and it is the selected width', () => {
    const w = mountSel('r-apac')
    const pressed = w.findAll('button').filter((b) => b.attributes('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
    expect(pressed[0]!.text()).toBe('APAC')
  })

  it('moves the pressed state when the model changes', async () => {
    const w = mountSel('all')
    expect(w.find('[data-testid="region-pill-all"]').attributes('aria-pressed')).toBe('true')
    await w.setProps({ modelValue: 'r-emea' })
    expect(w.find('[data-testid="region-pill-all"]').attributes('aria-pressed')).toBe('false')
    expect(w.find('[data-testid="region-pill-emea"]').attributes('aria-pressed')).toBe('true')
  })

  /*
   * ONE IDIOM PER PAGE: this is the same group/aria-pressed shape DriversTable's
   * axis chips use, so the two chip rows on one page are one control to a screen
   * reader rather than two that happen to look alike.
   */
  it('is a labelled toggle GROUP, like the drivers axis chips', () => {
    const g = mountSel().find('[data-testid="region-select"]')
    expect(g.attributes('role')).toBe('group')
    expect(g.attributes('aria-label')).toBe('Region')
  })
})

/*
 * MUTATION: swap `flex-wrap` for `overflow-x-auto` (or drop it) — this goes red.
 * The list grows with the estate, and a horizontally-clipped width is a width the
 * reader cannot discover.
 */
describe('UiRegionSelector — the row wraps rather than clipping', () => {
  it('wraps', () => {
    expect(mountSel().find('[data-testid="region-select"]').classes()).toContain('flex-wrap')
  })

  it('every pill is reachable as a real button — never a title-only affordance', () => {
    for (const b of mountSel().findAll('button')) {
      expect(b.attributes('type')).toBe('button')
      expect(b.text().length).toBeGreaterThan(0)
    }
  })
})
