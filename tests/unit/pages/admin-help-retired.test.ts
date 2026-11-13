/*
 * Roles & terms (#636): three roles, the retired three folded, and a link to a
 * retired role's anchor opens the fold so the "?" links never land on nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { reactive } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import HelpPage from '../../../app/pages/admin/help.vue'

const STUBS = {
  UiPageHead: { props: ['title', 'sub', 'eyebrow'], template: '<header>{{ title }}</header>' },
}

function stub(hash: string) {
  vi.stubGlobal('definePageMeta', () => {})
  vi.stubGlobal('useAdminAccess', () => ({ roleDisplay: 'Admin' }))
  const route = reactive({ hash })
  vi.stubGlobal('useRoute', () => route)
  return route
}

enableAutoUnmount(afterEach)
afterEach(() => vi.unstubAllGlobals())

describe('/admin/help roles', () => {
  it('lists Admin, Manager and Developer, with no code chips, and folds the retired roles', async () => {
    stub('')
    const w = mount(HelpPage, { global: { stubs: STUBS }, attachTo: document.body })
    await flushPromises()
    const section = w.find('section[aria-labelledby="h-roles"]')
    const active = section.find('dl').findAll(':scope > div').map((d) => d.find('dt').text())
    expect(active).toEqual(['Admin', 'Manager (role)', 'Developer'])
    expect(section.find('code').exists()).toBe(false)
    const fold = w.find('[data-testid="retired-roles"]')
    expect(fold.find('summary').text()).toBe('Retired roles (3)')
    expect((fold.element as HTMLDetailsElement).open).toBe(false)
    expect(w.text()).toContain('Global finance')
    expect(w.text()).not.toMatch(/global-finops|platform-admin/)
  })

  it('opens the fold when the page is opened at a retired role\'s anchor', async () => {
    stub('#global-finance')
    const w = mount(HelpPage, { global: { stubs: STUBS }, attachTo: document.body })
    await flushPromises()
    expect((w.find('[data-testid="retired-roles"]').element as HTMLDetailsElement).open).toBe(true)
    expect(w.find('#global-finance').exists()).toBe(true)
  })

  it('keeps every anchor id the admin "?" links use', async () => {
    stub('')
    const w = mount(HelpPage, { global: { stubs: STUBS }, attachTo: document.body })
    await flushPromises()
    for (const id of ['platform-admin', 'region-admin', 'global-finance', 'manager-role', 'developer', 'finance-retired', 'cost-centre-owner', 'region-leader']) {
      expect(w.find(`#${id}`).exists(), id).toBe(true)
    }
  })
})
