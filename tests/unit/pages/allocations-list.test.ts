/*
 * Project budgets list (#632): one line per project with the budget in force,
 * earlier lines folded, nothing raw from the database on screen.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import AllocationsPage from '../../../app/pages/allocations/index.vue'
import { groupBudgetLines, kindWord, type BudgetLine } from '../../../app/components/allocator/budget-groups'

const P1 = '9a1e0000-0000-4000-8000-000000000a01'
const P2 = '9a1e0000-0000-4000-8000-000000000a02'

function line(over: Partial<BudgetLine>): BudgetLine {
  return {
    id: '9a1e0000-0000-4000-8000-000000000b00',
    scope_type: 'project',
    scope_id: P1,
    budget_usd: '1000.00',
    allocation_kind: 'baseline',
    is_pool: true,
    is_current: false,
    effective_from: '2026-11-01T00:00:00.000Z',
    effective_to: '2026-12-01T00:00:00.000Z',
    project_code: 'ATLAS',
    project_display_name: 'Atlas',
    project_budget_now: 1500,
    ...over,
  }
}

const ATLAS = [
  line({ id: '9a1e0000-0000-4000-8000-000000000b01', is_current: true }),
  line({ id: '9a1e0000-0000-4000-8000-000000000b02', allocation_kind: 'top-up', budget_usd: '500.00', is_current: true, effective_from: '2026-11-10T00:00:00.000Z' }),
  line({ id: '9a1e0000-0000-4000-8000-000000000b03', effective_from: '2026-10-01T00:00:00.000Z', effective_to: '2026-11-01T00:00:00.000Z' }),
  line({ id: '9a1e0000-0000-4000-8000-000000000b04', effective_from: '2026-09-01T00:00:00.000Z', effective_to: '2026-10-01T00:00:00.000Z' }),
]
const DORMANT = [
  line({
    id: '9a1e0000-0000-4000-8000-000000000b05',
    scope_id: P2,
    project_code: 'BOREAS',
    project_display_name: 'Boreas',
    project_budget_now: 0,
    effective_from: '2026-08-01T00:00:00.000Z',
    effective_to: '2026-09-01T00:00:00.000Z',
  }),
]

describe('groupBudgetLines', () => {
  it('one group per project; the headline is the current baseline with the server\'s budget', () => {
    const { inForce, notInForce } = groupBudgetLines([...ATLAS, ...DORMANT])
    expect(inForce).toHaveLength(1)
    const g = inForce[0]!
    expect(g.headline.id).toBe(ATLAS[0]!.id)
    expect(g.budgetNow).toBe(1500)
    expect(g.breakdown).toEqual({ baselineUsd: 1000, topupUsd: 500 })
    expect(g.others.map((o) => o.id)).toEqual([ATLAS[1]!.id, ATLAS[2]!.id, ATLAS[3]!.id])
    expect(notInForce.map((n) => n.name)).toEqual(['Boreas'])
  })

  it('no breakdown when the parts do not add up to the server\'s figure (never a second definition)', () => {
    const lines = ATLAS.map((l) => ({ ...l, project_budget_now: 1700 }))
    expect(groupBudgetLines(lines).inForce[0]!.breakdown).toBeNull()
  })

  it('"N earlier budgets" only when every other line is earlier', () => {
    const onlyPast = [ATLAS[0]!, ATLAS[2]!, ATLAS[3]!].map((l) => ({ ...l, project_budget_now: 1000 }))
    expect(groupBudgetLines(onlyPast).inForce[0]!.othersLabel).toBe('2 earlier budgets')
    expect(groupBudgetLines(ATLAS).inForce[0]!.othersLabel).toBe('3 other budget lines')
  })

  it('kinds read as words', () => {
    expect(kindWord({ allocation_kind: 'top-up', is_pool: true })).toBe('Top-up')
    expect(kindWord({ allocation_kind: 'baseline', is_pool: true })).toBe('Baseline')
    expect(kindWord({ allocation_kind: 'baseline', is_pool: false })).toBe('Developer cap')
  })
})

const PASS = { template: '<div><slot /><slot name="actions" /></div>' }
const STUBS = {
  UiPageHead: { props: ['sub', 'title', 'eyebrow'], template: '<header><p>{{ eyebrow }}</p><h1>{{ title }}</h1><p>{{ sub }}</p></header>' },
  UiCard: PASS,
  UiBadge: { template: '<span><slot /></span>' },
  UiButton: { template: '<button v-bind="$attrs"><slot /></button>' },
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
}

function stub(data: unknown) {
  vi.stubGlobal('useSession', () => ({ session: ref({ role: 'manager' }), ensure: async () => {} }))
  vi.stubGlobal('useFetch', () => ({ data: ref(data), error: ref(null), pending: ref(false), refresh: vi.fn() }))
}

async function mountPage() {
  const Parent = defineComponent({ components: { Page: AllocationsPage as never }, template: '<Suspense><Page /></Suspense>' })
  const w = mount(Parent, {
    global: { stubs: STUBS, mocks: { fmtUsd: (v: unknown) => `$${Number(v).toLocaleString('en-US')}` } },
  })
  await flushPromises()
  return w
}

enableAutoUnmount(afterEach)
afterEach(() => vi.unstubAllGlobals())

describe('/allocations page', () => {
  it('shows one line per project, periods in words, nothing raw', async () => {
    stub({ allocations: [...ATLAS, ...DORMANT], total: 2, total_lines: 5, limit: 100, offset: 0 })
    const w = await mountPage()
    expect(w.text()).toContain('Budgets')
    expect(w.findAll('[data-testid="budget-project-row"]')).toHaveLength(1)
    expect(w.find('[data-testid="budget-now"]').text()).toBe('$1,500')
    expect(w.find('[data-testid="budget-breakdown"]').text()).toBe('$1,000 baseline + $500 top-up')
    expect(w.find('[data-testid="budget-period"]').text()).toBe('1 to 30 Nov 2026')
    expect(w.text()).toContain('No budget in force (1)')
    expect(w.find('[data-testid="allocations-showing"]').text()).toBe('Showing 2 projects.')
    expect(w.find('[data-testid="allocations-load-more"]').exists()).toBe(false)

    await w.find('[data-testid="budget-others-toggle"]').trigger('click')
    await w.find('[data-testid="budget-not-in-force-toggle"]').trigger('click')
    expect(w.findAll('[data-testid="budget-other-row"]')).toHaveLength(3)
    expect(w.text()).toContain('1 to 31 Aug 2026')
  })

  it('a project with nothing in force still reaches its older lines (PO, PR 639)', async () => {
    const older = { ...DORMANT[0]!, id: '9a1e0000-0000-4000-8000-000000000b06', effective_from: '2026-07-01T00:00:00.000Z', effective_to: '2026-08-01T00:00:00.000Z' }
    stub({ allocations: [...DORMANT, older], total: 1, total_lines: 2, limit: 100, offset: 0 })
    const w = await mountPage()
    await w.find('[data-testid="budget-not-in-force-toggle"]').trigger('click')
    await w.find('[data-testid="budget-others-toggle"]').trigger('click')
    const rows = w.findAll('[data-testid="budget-other-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('1 to 31 Jul 2026')
    expect(w.text()).not.toMatch(/\[|\+00/)
  })

  it('says how many it shows and offers Load more when there are more projects', async () => {
    stub({ allocations: ATLAS, total: 340, total_lines: 900, limit: 100, offset: 0 })
    const w = await mountPage()
    expect(w.find('[data-testid="allocations-showing"]').text()).toBe('Showing 1 of 340 projects.')
    expect(w.find('[data-testid="allocations-load-more"]').exists()).toBe(true)
  })
})
