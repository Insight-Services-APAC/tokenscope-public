// @vitest-environment happy-dom
/*
 * #642: an item the period-end sweep (#630) or a raised budget (#631) closed
 * shows no advice about acting on it. Its period is over, so "Add a $50 top-up"
 * contradicts the closed note directly above it. Open items are unchanged.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import InboxDrawer from '../../../app/components/inbox/InboxDrawer.vue'

const stubs = {
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  UiButton: true,
  UiBadge: true,
  UiPbar: true,
}

function item(category: string, body: Record<string, unknown>, ackState: 'unread' | 'resolved') {
  return {
    id: '9a1e0000-0000-4000-8000-000000000642',
    category,
    severity: 'attention' as const,
    subject: 'Acme',
    body,
    related_entity_kind: 'project',
    related_entity_id: '9a1e0000-0000-4000-8000-000000000001',
    target_allocation_id: '9a1e0000-0000-4000-8000-000000000002',
    target_project_code: 'ACME',
    ack_state: ackState,
    ack_at: null,
    created_at: '2026-10-20T00:00:00Z',
  }
}

const monthEnded = { closed_reason: 'period-ended', closed_month: '2026-10' }
const weekEnded = { closed_reason: 'period-ended', closed_week_start: '2026-10-26' }
const raised = { closed_reason: 'budget-raised', closed_cap_usd: 3000 }

const cases = [
  {
    name: 'over budget',
    category: 'over-budget',
    body: { usedUsd: 2012.88, capUsd: 2000, project: 'Acme' },
    closes: [monthEnded, raised],
    advice: [/Suggested action/i, /top-up/i],
  },
  {
    name: 'nearly used',
    category: 'budget-nearly-used',
    body: { usedUsd: 1700, capUsd: 2000, month: '2026-10', day: 20 },
    closes: [monthEnded, raised],
    advice: [/What you can do/, /What happens if you do nothing/, /top-up/i],
  },
  {
    name: 'spending fast',
    category: 'velocity-warning',
    body: { weeklySeries: [90, 100, 145], meanUsd: 100, currentUsd: 145, deltaPct: 0.45 },
    closes: [weekEnded],
    advice: [/What to do/, /resolve this alert/],
  },
  // DrawerBodySections kinds the sweep also closes (period-close.ts).
  { name: 'untagged backlog', category: 'untagged-backlog', body: { month: '2026-10' }, closes: [monthEnded], advice: [/What to do/] },
  { name: 'reconciliation gap', category: 'reconciliation-gap', body: { month: '2026-10' }, closes: [monthEnded], advice: [/What to do/] },
  { name: 'over attribution', category: 'over-attribution', body: { month: '2026-10' }, closes: [monthEnded], advice: [/What to do/] },
]

describe('a closed alert gives no advice (#642)', () => {
  for (const c of cases) {
    it(`${c.name}: an open item still shows its advice`, () => {
      const w = mount(InboxDrawer, { props: { item: item(c.category, c.body, 'unread') }, global: { stubs } })
      const text = w.find('[data-testid="drawer-body"]').text()
      for (const re of c.advice) expect(text).toMatch(re)
    })

    for (const close of c.closes) {
      it(`${c.name}: closed as ${close.closed_reason}, the drawer has the note and no advice`, () => {
        const w = mount(InboxDrawer, {
          props: { item: item(c.category, { ...c.body, ...close }, 'resolved') },
          global: { stubs },
        })
        expect(w.find('[data-testid="drawer-closed-note"]').exists()).toBe(true)
        const text = w.find('[data-testid="drawer-body"]').text()
        for (const re of c.advice) expect(text).not.toMatch(re)
      })
    }
  }
})
