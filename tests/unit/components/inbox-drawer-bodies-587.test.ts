// @vitest-environment happy-dom
/*
 * #587: the velocity drawer uses the three-part layout and no longer says
 * Acknowledge clears the bell; over-budget top-up copy is right past 100%;
 * money has thousands separators; "Created" uses the product's format.
 * #588: the bell badge sits off the icon and caps at 99+.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import DrawerBodyVelocity from '../../../app/components/inbox/DrawerBodyVelocity.vue'
import DrawerBodyOverBudget from '../../../app/components/inbox/DrawerBodyOverBudget.vue'

const ROOT = resolve(__dirname, '../../..')

describe('Spending fast drawer (#587)', () => {
  const body = { weeklySeries: [90, 100, 110, 100, 145], meanUsd: 100, currentUsd: 3678.17, deltaPct: 0.45 }
  it('has What happened, What it means and What to do', () => {
    const w = mount(DrawerBodyVelocity, { props: { body } })
    const heads = w.findAll('h3').map((h) => h.text())
    expect(heads).toEqual(['What happened', 'What it means', 'What to do'])
    expect(w.find('[data-testid="velocity-happened"]').text()).toContain('45% more than a typical week')
  })
  it('never says acknowledging clears the bell', () => {
    const w = mount(DrawerBodyVelocity, { props: { body } })
    expect(w.text()).not.toMatch(/acknowledge to\s+clear the bell/i)
    expect(w.text()).not.toMatch(/clear the bell/i)
  })
  it('money has thousands separators', () => {
    const w = mount(DrawerBodyVelocity, { props: { body } })
    expect(w.text()).toContain('$3,678.17')
    expect(w.text()).not.toContain('$3678.17')
  })
})

describe('Over budget drawer (#587)', () => {
  const stubs = { UiPbar: true }
  it('past 100% it covers "the N% over", never "the remaining"', () => {
    const w = mount(DrawerBodyOverBudget, {
      props: { body: { usedUsd: 2012.88, capUsd: 2000, suggestedTopupUsd: 50, project: 'Acme' } },
      global: { stubs },
    })
    const text = w.text()
    expect(text).not.toContain('remaining')
    expect(text).toMatch(/to cover the\s+1% over/)
    expect(text).toContain('$2,012.88 of $2,000.00')
  })
  it('the suggested top-up covers the overrun: $54 over suggests $60, never $50', () => {
    const w = mount(DrawerBodyOverBudget, {
      props: { body: { usedUsd: 1054, capUsd: 1000, project: 'Acme' } },
      global: { stubs },
    })
    expect(w.text()).toContain('Add a $60 top-up')
  })
})

describe('drawer "Created" (#587)', () => {
  it('uses the shared instant format, not a bare toLocaleString', () => {
    const src = readFileSync(resolve(ROOT, 'app/components/inbox/InboxDrawer.vue'), 'utf8')
    expect(src).toContain('Created {{ fmtInstant(item.created_at) }}')
    expect(src).not.toMatch(/created_at\)\.toLocaleString/)
  })
})

describe('header bell badge (#588)', () => {
  const src = readFileSync(resolve(ROOT, 'app/components/nav/AppHeader.vue'), 'utf8')
  const badge = src.slice(src.indexOf('data-testid="inbox-bell-badge"') - 400, src.indexOf('data-testid="inbox-bell-badge"') + 200)
  it('sits above and to the right of the icon, not over its corner', () => {
    expect(badge).toContain('top-0')
    expect(badge).toContain('left-[calc(50%+4px)]')
    expect(badge).not.toContain('right-1.5')
  })
  it('caps at 99+ while the accessible name keeps the real count', () => {
    expect(badge).toContain("unreadCount > 99 ? '99+' : unreadCount")
    expect(src).toContain('`Inbox, ${unreadCount} unread`')
    expect(badge).toContain('aria-hidden="true"')
  })
})
