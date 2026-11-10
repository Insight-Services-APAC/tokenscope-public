// @vitest-environment happy-dom
/*
 * The inbox filter bar (#546): six category groups and All, status Open /
 * Unread / Closed / All, each row a labelled group whose buttons announce
 * which one is selected (aria-pressed). The testid shape is unchanged
 * (filter-category-*, filter-status-*, filter-severity-*).
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import InboxFilterBar from '../../../app/components/inbox/InboxFilterBar.vue'

const STUBS = { UiCard: { template: '<div><slot /></div>' } }

function mountBar(props: Record<string, unknown> = {}) {
  return mount(InboxFilterBar, {
    props: { category: 'all', severity: 'all', status: 'open', ...props },
    global: { stubs: STUBS },
  })
}

describe('InboxFilterBar', () => {
  it('offers the six groups and All, by name', () => {
    const w = mountBar()
    const labels = w.findAll('[data-testid^="filter-category-"]').map((b) => b.text())
    expect(labels).toEqual(['All', 'Budgets', 'Requests', 'Projects', 'Data health', 'Copilot billing', 'Other'])
  })

  it('offers Open, Unread, Closed and All, with Open pressed', () => {
    const w = mountBar()
    expect(w.findAll('[data-testid^="filter-status-"]').map((b) => b.text())).toEqual(['Open', 'Unread', 'Closed', 'All'])
    expect(w.find('[data-testid="filter-status-open"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="filter-status-all"]').attributes('aria-pressed')).toBe('false')
  })

  it('every row is a labelled group and every button says whether it is pressed', () => {
    const w = mountBar({ category: 'requests', severity: 'urgent' })
    const groups = w.findAll('[role="group"]')
    expect(groups).toHaveLength(3)
    for (const g of groups) {
      const id = g.attributes('aria-labelledby')
      expect(id && w.find(`#${id}`).text()).toBeTruthy()
    }
    for (const b of w.findAll('button')) expect(['true', 'false']).toContain(b.attributes('aria-pressed'))
    expect(w.find('[data-testid="filter-category-requests"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="filter-severity-urgent"]').attributes('aria-pressed')).toBe('true')
  })

  it('shows a count beside a group that has items', () => {
    const w = mountBar({ groupCounts: { budgets: 1, requests: 2, projects: 0 } })
    expect(w.find('[data-testid="filter-category-count-requests"]').text()).toBe('2')
    expect(w.find('[data-testid="filter-category-count-projects"]').exists()).toBe(false)
  })

  it('emits the group key and the status key', async () => {
    const w = mountBar()
    await w.find('[data-testid="filter-category-data-health"]').trigger('click')
    await w.find('[data-testid="filter-status-closed"]').trigger('click')
    expect(w.emitted('update:category')?.[0]).toEqual(['data-health'])
    expect(w.emitted('update:status')?.[0]).toEqual(['closed'])
  })
})
