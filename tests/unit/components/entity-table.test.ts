// @vitest-environment happy-dom
/*
 * EntityTable — search emit + empty-state render contract.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EntityTable from '../../../app/components/admin/EntityTable.vue'

describe('EntityTable', () => {
  it('renders an empty state when rows is []', () => {
    const wrapper = mount(EntityTable, {
      props: {
        entityLabel: 'Teammates',
        rows: [],
        columns: [{ key: 'email', label: 'Email' }],
        total: 0,
      },
    })
    expect(wrapper.text()).toContain('No teammates yet')
  })

  it('renders rows with the supplied column set', () => {
    const wrapper = mount(EntityTable, {
      props: {
        entityLabel: 'Teammates',
        rows: [
          { email: 'a@x.com', name: 'A' },
          { email: 'b@x.com', name: 'B' },
        ],
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'email', label: 'Email' },
        ],
        total: 2,
      },
    })
    expect(wrapper.text()).toContain('a@x.com')
    expect(wrapper.text()).toContain('b@x.com')
  })

  it('filters rows client-side as you type (no no-op search emit)', async () => {
    const wrapper = mount(EntityTable, {
      props: {
        entityLabel: 'Teammates',
        rows: [{ email: 'priya@x.com' }, { email: 'anil@x.com' }],
        columns: [{ key: 'email', label: 'Email' }],
        total: 2,
      },
    })
    expect(wrapper.text()).toContain('priya@x.com')
    expect(wrapper.text()).toContain('anil@x.com')
    await wrapper.find('[data-testid="entity-search-teammates"]').setValue('priya')
    expect(wrapper.text()).toContain('priya@x.com')
    expect(wrapper.text()).not.toContain('anil@x.com')
  })

  it('uses the optional render fn when provided', () => {
    const wrapper = mount(EntityTable, {
      props: {
        entityLabel: 'Projects',
        rows: [{ code: 'X', is_onboarded: true }, { code: 'Y', is_onboarded: false }],
        columns: [
          { key: 'code', label: 'Code' },
          {
            key: 'is_onboarded',
            label: 'Onboarded',
            render: (r: Record<string, unknown>) => (r.is_onboarded ? 'Yes' : 'Catalogue'),
          },
        ],
      },
    })
    expect(wrapper.text()).toContain('Yes')
    expect(wrapper.text()).toContain('Catalogue')
  })

  it('renders a working "+ Add" link (no dead/disabled stubs) when addTo is set', () => {
    const wrapper = mount(EntityTable, {
      props: {
        entityLabel: 'Projects',
        rows: [{ code: 'X' }],
        columns: [{ key: 'code', label: 'Code' }],
        addTo: '/projects/new',
      },
      global: {
        stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } },
      },
    })
    // No dead/disabled stub buttons anywhere (the old "Upload CSV" + disabled
    // "+ Add" read as broken).
    expect(wrapper.findAll('button[disabled]')).toHaveLength(0)
    const add = wrapper.find('[data-testid="entity-add-projects"]')
    expect(add.exists()).toBe(true)
    expect(add.text()).toContain('Add project')
    expect(add.attributes('href')).toBe('/projects/new')
  })

  it('shows the #addHint guidance (not a dead button) when addTo is unset', () => {
    const wrapper = mount(EntityTable, {
      props: {
        entityLabel: 'Teammates',
        rows: [{ email: 'a@x.com' }],
        columns: [{ key: 'email', label: 'Email' }],
      },
      slots: { addHint: 'Teammates self-onboard on first sign-in.' },
    })
    expect(wrapper.findAll('button[disabled]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="entity-add-teammates"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('self-onboard')
  })
})
