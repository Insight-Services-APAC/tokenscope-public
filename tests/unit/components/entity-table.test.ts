// @vitest-environment happy-dom
/*
 * EntityTable — search emit + empty-state render contract, and the two
 * behaviours the placement worklist rests on: a selection that survives the
 * filter, and a money column that sorts by its NUMBER.
 */
import { describe, it, expect } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
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

  /*
   * SELECTION. The whole bulk action depends on the chosen set surviving the
   * admin narrowing the view: 12 people are picked, the search is refined to
   * check one of them, and acting on the result must still act on 12. Silently
   * dropping the rows that left the filter would place fewer people than the
   * button offered to place, with no indication it had happened.
   */
  const selectable = (rows: Record<string, unknown>[]) =>
    mount(EntityTable, {
      props: {
        entityLabel: 'Teammates',
        rows,
        columns: [{ key: 'email', label: 'Email' }],
        // No `selected` prop and no listener: defineModel keeps the value locally,
        // so the component's OWN behaviour is under test rather than a round-trip
        // the test wrote itself.
        rowKey: (r: Record<string, unknown>) => String(r.id),
      },
    })
  /** The latest value the table pushed out through v-model:selected. */
  const lastSelection = (w: VueWrapper): string[] => {
    const events = w.emitted('update:selected') as string[][][] | undefined
    return events?.length ? events[events.length - 1]![0]! : []
  }

  it('keeps a row selected after it leaves the filter', async () => {
    const wrapper = selectable([
      { id: '1', email: 'priya@x.com' },
      { id: '2', email: 'anil@x.com' },
    ])

    await wrapper.find('[data-testid="entity-select-teammates-1"]').trigger('change')
    expect(lastSelection(wrapper)).toEqual(['1'])
    expect(wrapper.find('[data-testid="entity-selection-teammates"]').text()).toContain('1 selected')

    // Priya leaves the filter…
    await wrapper.find('[data-testid="entity-search-teammates"]').setValue('anil')
    expect(wrapper.text()).not.toContain('priya@x.com')
    // …but not the selection, and the count still states the real total.
    expect(lastSelection(wrapper)).toEqual(['1'])
    expect(wrapper.find('[data-testid="entity-selection-teammates"]').text()).toContain('1 selected')
  })

  it('select-all takes the FILTERED rows only, and unticking drops just those', async () => {
    const wrapper = selectable([
      { id: '1', email: 'priya@x.com' },
      { id: '2', email: 'anil@x.com' },
      { id: '3', email: 'anil.b@x.com' },
    ])

    await wrapper.find('[data-testid="entity-search-teammates"]').setValue('anil')
    await wrapper.find('[data-testid="entity-select-all-teammates"]').trigger('change')
    // Never a total the client has not loaded, and never a row off-filter.
    expect([...lastSelection(wrapper)].sort()).toEqual(['2', '3'])

    await wrapper.find('[data-testid="entity-select-all-teammates"]').trigger('change')
    expect(lastSelection(wrapper)).toEqual([])
  })

  /*
   * SORTING. "Sorted by spend descending, so the largest money is dealt with
   * first" is the entire reason the worklist has a spend column — and the cell
   * TEXT is a formatted currency string, which does not order like the number it
   * renders.
   */
  it('sorts a money column by its number, not by the rendered text', async () => {
    const wrapper = mount(EntityTable, {
      props: {
        entityLabel: 'Teammates',
        rows: [
          { id: 'big', email: 'big@x.com', spend: '1200.50' },
          { id: 'small', email: 'small@x.com', spend: '900.00' },
        ],
        columns: [
          { key: 'email', label: 'Email' },
          {
            key: 'spend',
            label: 'Spend',
            sortable: true,
            align: 'right',
            sortValue: (r: Record<string, unknown>) => Number(r.spend ?? 0),
            // As the page formats it: '$1,200.50' sorts BEFORE '$900.00' as text
            // (even under numeric collation, which compares the leading 1 to 9),
            // which is exactly backwards.
            render: (r: Record<string, unknown>) =>
              `$${Number(r.spend ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
          },
        ],
      },
    })

    const emails = () => wrapper.findAll('tbody tr').map((tr) => tr.findAll('td')[0]!.text())
    expect(wrapper.find('[data-testid="entity-sort-teammates-spend"]').exists()).toBe(true)

    // asc: 900 before 1,200.50
    await wrapper.find('[data-testid="entity-sort-teammates-spend"]').trigger('click')
    expect(emails()).toEqual(['small@x.com', 'big@x.com'])

    // desc: the largest spender first — the worklist's default reading order.
    await wrapper.find('[data-testid="entity-sort-teammates-spend"]').trigger('click')
    expect(emails()).toEqual(['big@x.com', 'small@x.com'])

    // A third click returns to the server's order rather than a third sort mode.
    await wrapper.find('[data-testid="entity-sort-teammates-spend"]').trigger('click')
    expect(emails()).toEqual(['big@x.com', 'small@x.com'])
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
