// @vitest-environment happy-dom
/*
 * #612: the Admin overview's "Audit events · 24h" tile read "…" for good.
 *
 * The audit read waits on the server clock (its 24-hour cutoff comes from the
 * server's `now`). The clock usually lands in the server-rendered payload, so it
 * is already present when the page sets up and never CHANGES; the old
 * `watch: [since24h]` option never fired and the read was never issued. These
 * tests mount the real page with the clock already present, landing later, and
 * failing. `useLazyFetch` and the clock are the only fakes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, type Ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import AdminOverview from '../../../app/pages/admin/index.vue'
import { stubServerClock } from '../../helpers/server-clock'

interface LazyEntry {
  data: Ref<unknown>
  error: Ref<unknown>
  refresh: ReturnType<typeof vi.fn>
  url: () => string
}
const lazy = new Map<string, LazyEntry>()

const STUBS = {
  UiPageHead: { props: ['title', 'sub', 'eyebrow'], template: '<h1>{{ title }}</h1>' },
  UiCard: { template: '<div><slot /></div>' },
  UiFetchErrorBanner: {
    props: ['error', 'label'],
    emits: ['retry'],
    template: '<div v-if="error" data-testid="fetch-error-banner">{{ label }}<button data-testid="fetch-error-retry" @click="$emit(\'retry\')" /></div>',
  },
  OrgSetupHomeCard: { template: '<div />' },
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
}

function stubGlobals() {
  vi.stubGlobal('definePageMeta', () => {})
  vi.stubGlobal('useSession', () => ({ session: ref({ role: 'platform-admin', regionId: '', displayName: 'Ada' }) }))
  vi.stubGlobal('useLazyFetch', (url: string | (() => string), opts: { key: string }) => {
    const entry: LazyEntry = {
      data: ref<unknown>(null),
      error: ref<unknown>(null),
      url: typeof url === 'function' ? url : () => url,
      refresh: vi.fn(async () => {
        if (opts.key === 'admin-overview-audit') entry.data.value = { total: 1234 }
      }),
    }
    lazy.set(opts.key, entry)
    return entry
  })
}

const audit = () => lazy.get('admin-overview-audit')!
const auditTile = (w: ReturnType<typeof mount>) => w.get('[data-testid="admin-stat-audit"]')

beforeEach(() => {
  lazy.clear()
  stubGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Admin overview audit tile (#612)', () => {
  it('issues the audit read when the clock is already present at setup', async () => {
    stubServerClock('2026-11-11T10:00:00Z')
    const w = mount(AdminOverview, { global: { stubs: STUBS } })
    await flushPromises()
    expect(audit().refresh).toHaveBeenCalledTimes(1)
    expect(audit().url()).toBe(`/api/v1/admin/audit?limit=1&since=${encodeURIComponent('2026-11-10T10:00:00.000Z')}`)
    expect(auditTile(w).attributes('data-state')).toBe('ready')
    expect(auditTile(w).text()).toContain('1,234')
  })

  it('issues it once the clock lands after mount, and reads busy until then', async () => {
    const clock = stubServerClock(null)
    const w = mount(AdminOverview, { global: { stubs: STUBS } })
    await flushPromises()
    expect(audit().refresh).not.toHaveBeenCalled()
    expect(auditTile(w).attributes('data-state')).toBe('busy')
    clock.value.value = stubServerClock('2026-11-11T10:00:00Z').value.value
    await flushPromises()
    expect(audit().refresh).toHaveBeenCalledTimes(1)
    expect(auditTile(w).attributes('data-state')).toBe('ready')
  })

  it('a failed clock read shows the error state, and Retry re-reads the clock', async () => {
    const clock = stubServerClock(null)
    clock.error.value = new Error('clock read failed')
    const w = mount(AdminOverview, { global: { stubs: STUBS } })
    await flushPromises()
    expect(auditTile(w).attributes('data-state')).toBe('error')
    expect(w.get('[data-testid="fetch-error-banner"]').text()).toContain('Audit events')
    await w.get('[data-testid="fetch-error-retry"]').trigger('click')
    expect(clock.refresh).toHaveBeenCalledTimes(1)
    expect(audit().refresh).not.toHaveBeenCalled()
  })
})
