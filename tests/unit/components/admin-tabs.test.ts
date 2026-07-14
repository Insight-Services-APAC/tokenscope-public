// @vitest-environment happy-dom
/*
 * AdminTabs — v-model emit + aria-current contract.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AdminTabs, { type AdminTab } from '../../../app/components/admin/AdminTabs.vue'

const TABS: AdminTab[] = [
  { key: 'checklist', label: 'Setup checklist' },
  { key: 'org-units', label: 'Org units', count: 12 },
  { key: 'connectors', label: 'Connectors' },
]

describe('AdminTabs', () => {
  it('marks the active tab via aria-current', () => {
    const wrapper = mount(AdminTabs, {
      props: { tabs: TABS, modelValue: 'org-units' },
    })
    expect(wrapper.find('[data-testid="admin-tab-org-units"]').attributes('aria-current')).toBe('true')
    expect(wrapper.find('[data-testid="admin-tab-checklist"]').attributes('aria-current')).toBe('false')
  })

  it('emits update:modelValue on click', async () => {
    const wrapper = mount(AdminTabs, {
      props: { tabs: TABS, modelValue: 'checklist' },
    })
    await wrapper.find('[data-testid="admin-tab-connectors"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['connectors'])
  })

  it('renders count when provided', () => {
    const wrapper = mount(AdminTabs, {
      props: { tabs: TABS, modelValue: 'checklist' },
    })
    expect(wrapper.find('[data-testid="admin-tab-org-units"]').text()).toContain('12')
  })
})
