// @vitest-environment happy-dom
/*
 * My account (#581, with #576's rename): one page that never shows a false
 * "none yet". Each read has its own state; a failed read says it failed and
 * offers Retry; only a landed read may say "none yet". The device rename saves,
 * re-reads and shows; the no-projects line points to Request a project.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import AccountPage from '../../../app/pages/account.vue'

type Read = { data?: unknown; error?: unknown; pending?: boolean }

const DEVICE = {
  instance_id: '9a1e0000-0000-4000-8000-000000000001',
  tool: 'claude-code',
  display_name: null as string | null,
  project: null,
  ts_start: '2026-09-03T00:00:00Z',
  ts_actual_end: null,
  last_emission: '2026-11-10T00:00:00Z',
  spend_usd_mtd: '41.20',
  revoked: false,
  state: 'sending',
}

const HEALTHY: Record<string, Read> = {
  '/api/v1/me/identities': { data: { primary: 'alex@example.com', identities: [] } },
  '/api/v1/me/projects': { data: { projects: [] } },
  '/api/v1/me/instances': { data: { instances: [DEVICE] } },
  '/api/v1/me/provisional-instances': { data: { provisional_instances: [] } },
  '/api/v1/me/grants': { data: { grants: [] } },
  '/api/v1/me/personal-subscription': { data: { declarations: [] } },
}

const refreshes: Record<string, ReturnType<typeof vi.fn>> = {}

function mountPage(over: Record<string, Read> = {}) {
  const reads = { ...HEALTHY, ...over }
  vi.stubGlobal('useLazyFetch', (url: string) => {
    const r = reads[url] ?? {}
    refreshes[url] = vi.fn()
    return {
      data: ref(r.data ?? null),
      error: ref(r.error ?? null),
      pending: ref(r.pending ?? false),
      refresh: refreshes[url],
    }
  })
  vi.stubGlobal('useFetch', () => ({ data: ref(null), error: ref(null) }))
  vi.stubGlobal('apiErrorDetail', (_e: unknown, fallback: string) => fallback)
  return mount(AccountPage, {
    global: {
      stubs: {
        UiPageHead: { props: ['eyebrow', 'title', 'sub'], template: '<header><p>{{ eyebrow }}</p><h1>{{ title }}</h1><p>{{ sub }}</p></header>' },
        UiCard: { template: '<div v-bind="$attrs"><slot /></div>' },
        UiEyebrow: { template: '<div><slot /></div>' },
        UiBadge: { template: '<span><slot /></span>' },
        UiButton: { props: ['type'], template: '<button :type="type ?? \'button\'" v-bind="$attrs"><slot /></button>' },
        UiCodeBlock: true,
        ConnectClientGuide: true,
        NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
      },
    },
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('My account — the page head and section list (#581)', () => {
  it('is titled "My account" with the shared head and lists every section with an anchor', async () => {
    const w = mountPage()
    await flushPromises()
    expect(w.find('h1').text()).toBe('My account')
    const links = w.findAll('[data-testid^="account-section-link-"]').map((a) => a.attributes('href'))
    expect(links).toEqual(['#identities', '#your-devices', '#connections', '#connect-a-tool', '#tag-a-repo', '#personal-subscription'])
    for (const href of links) expect(w.find(href!).exists(), href).toBe(true)
  })

  it('device money uses the shared formatter, with thousands separators (#591)', async () => {
    const w = mountPage({
      '/api/v1/me/instances': { data: { instances: [{ ...DEVICE, spend_usd_mtd: '1448.64' }] } },
    })
    await flushPromises()
    expect(w.get(`[data-testid="instance-spend-${DEVICE.instance_id}"]`).text()).toBe('$1,448.64')
  })

  it('keeps the anchors other pages link to', async () => {
    const w = mountPage()
    await flushPromises()
    // The inbox's "Open my devices", the personal-subscription drawer, the Copilot guide.
    expect(w.find('#your-devices').exists()).toBe(true)
    expect(w.find('#personal-subscription').exists()).toBe(true)
    expect(w.find('#connect-copilot-cli').exists()).toBe(true)
  })

  it('shows the head and the section list while every read is still loading', async () => {
    const loading = Object.fromEntries(Object.keys(HEALTHY).map((k) => [k, { pending: true }]))
    const w = mountPage(loading)
    await flushPromises()
    expect(w.find('h1').text()).toBe('My account')
    expect(w.find('[data-testid="account-sections"]').exists()).toBe(true)
    expect(w.find('[data-testid="my-instances-loading"]').exists()).toBe(true)
    expect(w.find('[data-testid="my-instances-empty"]').exists()).toBe(false)
  })
})

describe('My account — a failed read is a failure, never "none yet" (#581)', () => {
  it('devices read failing: the card says so and offers Retry; never "No devices connected yet"', async () => {
    const w = mountPage({ '/api/v1/me/instances': { error: new Error('boom') } })
    await flushPromises()
    expect(w.find('[data-testid="my-instances-error"]').text()).toContain("We couldn't load your devices.")
    expect(w.find('[data-testid="my-instances-empty"]').exists()).toBe(false)
    expect(w.text()).not.toContain('No devices connected')
    await w.find('[data-testid="my-instances-retry"]').trigger('click')
    expect(refreshes['/api/v1/me/instances']).toHaveBeenCalled()
    // The status line says the check failed; it does not count zero devices.
    expect(w.find('[data-testid="account-status"]').text()).toContain("Devices couldn't be checked")
  })

  it.each([
    ['/api/v1/me/identities', 'identities', 'identity-none'],
    ['/api/v1/me/grants', 'my-grants', 'my-grants-empty'],
    ['/api/v1/me/projects', 'project-codes', 'no-project-codes'],
    ['/api/v1/me/personal-subscription', 'personal-subscription', 'personal-subscription-list'],
  ])('%s failing shows its own error and Retry, not its empty line', async (url, testid, emptyId) => {
    const w = mountPage({ [url]: { error: new Error('boom') } })
    await flushPromises()
    expect(w.find(`[data-testid="${testid}-error"]`).exists()).toBe(true)
    expect(w.find(`[data-testid="${emptyId}"]`).exists()).toBe(false)
    // The other cards are unaffected.
    expect(w.find('[data-testid="my-instances-list"]').exists()).toBe(true)
  })

  it('a landed empty read may say "none yet"', async () => {
    const w = mountPage({ '/api/v1/me/instances': { data: { instances: [] } } })
    await flushPromises()
    expect(w.find('[data-testid="my-instances-empty"]').text()).toContain('No devices connected yet')
  })

  it('with no projects, the line links to Request a project', async () => {
    const w = mountPage()
    await flushPromises()
    const line = w.find('[data-testid="no-project-codes"]')
    expect(line.text()).toContain('You are not a member of any project yet')
    expect(line.find('a').attributes('href')).toBe('/projects/request')
    expect(line.text()).not.toContain('ask an admin')
  })
})

describe('My account — naming a device (#576)', () => {
  it('an unnamed device reads as its tool and short id, never blank, and offers "Name this device"', async () => {
    const w = mountPage()
    await flushPromises()
    expect(w.find(`[data-testid="instance-name-${DEVICE.instance_id}"]`).text()).toContain('Claude Code')
    expect(w.find(`[data-testid="instance-name-${DEVICE.instance_id}"]`).text()).toContain('9a1e0000')
    expect(w.find(`[data-testid="instance-rename-${DEVICE.instance_id}"]`).text()).toBe('Name this device')
  })

  it('saves a trimmed name through PATCH, then re-reads the devices', async () => {
    const fetchMock = vi.fn().mockResolvedValue({})
    const w = mountPage()
    vi.stubGlobal('$fetch', fetchMock)
    await flushPromises()
    await w.find(`[data-testid="instance-rename-${DEVICE.instance_id}"]`).trigger('click')
    await w.find(`[data-testid="instance-rename-input-${DEVICE.instance_id}"]`).setValue('  Work laptop  ')
    await w.find(`[data-testid="instance-rename-form-${DEVICE.instance_id}"]`).trigger('submit')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/me/instances/${DEVICE.instance_id}`, {
      method: 'PATCH',
      body: { name: 'Work laptop' },
    })
    expect(refreshes['/api/v1/me/instances']).toHaveBeenCalled()
    expect(w.find(`[data-testid="instance-rename-form-${DEVICE.instance_id}"]`).exists()).toBe(false)
  })

  it('an empty name clears it (sends null)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({})
    const w = mountPage({ '/api/v1/me/instances': { data: { instances: [{ ...DEVICE, display_name: 'Old' }] } } })
    vi.stubGlobal('$fetch', fetchMock)
    await flushPromises()
    await w.find(`[data-testid="instance-rename-${DEVICE.instance_id}"]`).trigger('click')
    await w.find(`[data-testid="instance-rename-input-${DEVICE.instance_id}"]`).setValue('   ')
    await w.find(`[data-testid="instance-rename-form-${DEVICE.instance_id}"]`).trigger('submit')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/me/instances/${DEVICE.instance_id}`, { method: 'PATCH', body: { name: null } })
  })

  it('refuses a name over 40 characters before sending it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({})
    const w = mountPage()
    vi.stubGlobal('$fetch', fetchMock)
    await flushPromises()
    await w.find(`[data-testid="instance-rename-${DEVICE.instance_id}"]`).trigger('click')
    await w.find(`[data-testid="instance-rename-input-${DEVICE.instance_id}"]`).setValue('x'.repeat(41))
    await w.find(`[data-testid="instance-rename-form-${DEVICE.instance_id}"]`).trigger('submit')
    await flushPromises()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(w.find(`[data-testid="instance-rename-save-${DEVICE.instance_id}"]`).attributes('disabled')).toBeDefined()
  })

  it("a refused save shows the server's reason and keeps the field open", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('nope'))
    const w = mountPage()
    vi.stubGlobal('$fetch', fetchMock)
    vi.stubGlobal('apiErrorDetail', () => 'A device name cannot contain control or formatting characters')
    await flushPromises()
    await w.find(`[data-testid="instance-rename-${DEVICE.instance_id}"]`).trigger('click')
    await w.find(`[data-testid="instance-rename-input-${DEVICE.instance_id}"]`).setValue('ok')
    await w.find(`[data-testid="instance-rename-form-${DEVICE.instance_id}"]`).trigger('submit')
    await flushPromises()
    expect(w.find(`[data-testid="instance-rename-error-${DEVICE.instance_id}"]`).text()).toContain('control or formatting')
    expect(w.find(`[data-testid="instance-rename-form-${DEVICE.instance_id}"]`).exists()).toBe(true)
  })

  it('after a save, focus returns to that device\'s Rename button', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({}))
    const w = mountPage()
    document.body.appendChild(w.element)
    await flushPromises()
    await w.find(`[data-testid="instance-rename-${DEVICE.instance_id}"]`).trigger('click')
    await w.find(`[data-testid="instance-rename-input-${DEVICE.instance_id}"]`).setValue('Work laptop')
    await w.find(`[data-testid="instance-rename-form-${DEVICE.instance_id}"]`).trigger('submit')
    await flushPromises()
    expect(document.activeElement?.getAttribute('data-testid')).toBe(`instance-rename-${DEVICE.instance_id}`)
    w.unmount()
  })

  it('Escape cancels and returns focus to Rename', async () => {
    const w = mountPage()
    document.body.appendChild(w.element)
    await flushPromises()
    await w.find(`[data-testid="instance-rename-${DEVICE.instance_id}"]`).trigger('click')
    await w.find(`[data-testid="instance-rename-input-${DEVICE.instance_id}"]`).trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(w.find(`[data-testid="instance-rename-form-${DEVICE.instance_id}"]`).exists()).toBe(false)
    expect(document.activeElement?.getAttribute('data-testid')).toBe(`instance-rename-${DEVICE.instance_id}`)
    w.unmount()
  })

  it('a revoked device can still be renamed or cleared', async () => {
    const w = mountPage({ '/api/v1/me/instances': { data: { instances: [{ ...DEVICE, revoked: true, display_name: 'Old box' }] } } })
    await flushPromises()
    expect(w.find(`[data-testid="instance-rename-${DEVICE.instance_id}"]`).exists()).toBe(true)
  })

  it('a named device shows its name and offers Rename', async () => {
    const w = mountPage({ '/api/v1/me/instances': { data: { instances: [{ ...DEVICE, display_name: 'Work laptop' }] } } })
    await flushPromises()
    expect(w.find(`[data-testid="instance-name-${DEVICE.instance_id}"]`).text()).toBe('Work laptop')
    expect(w.find(`[data-testid="instance-rename-${DEVICE.instance_id}"]`).text()).toBe('Rename')
  })
})

describe('My account: devices in use, and the fold (#592)', () => {
  const id = (n: number) => `9a1e0000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const unused = (n: number, name: string | null = null) => ({
    ...DEVICE, instance_id: id(n), display_name: name, last_emission: '2026-06-01T00:00:00Z', state: 'not-in-use',
  })
  const withDevices = (instances: unknown[]) => ({ '/api/v1/me/instances': { data: { instances } } })

  it('the status line counts in use and not in use, and does not warn about idle', async () => {
    const w = mountPage(withDevices([DEVICE, { ...DEVICE, instance_id: id(2), state: 'idle' }, unused(3), unused(4)]))
    await flushPromises()
    const status = w.find('[data-testid="account-status"]').text()
    expect(status).toContain('2 devices in use · 2 not in use')
    expect(status).not.toContain('silent')
  })

  it('the fold is closed by default, counts its devices and is a real disclosure', async () => {
    const w = mountPage(withDevices([DEVICE, unused(3), unused(4)]))
    await flushPromises()
    const toggle = w.find('[data-testid="my-instances-fold-toggle"]')
    expect(toggle.text()).toContain('Not in use (2)')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(w.find(`[data-testid="instance-row-${id(3)}"]`).exists()).toBe(false)
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(w.find(`[data-testid="instance-row-${id(3)}"]`).exists()).toBe(true)
    expect(w.text()).toContain('These may still be able to send.')
  })

  it('Revoke all asks once, then revokes each through the single route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({})
    const confirmMock = vi.fn(() => true)
    const w = mountPage(withDevices([DEVICE, unused(3), unused(4)]))
    vi.stubGlobal('$fetch', fetchMock)
    vi.stubGlobal('confirm', confirmMock)
    await flushPromises()
    await w.find('[data-testid="my-instances-fold-toggle"]').trigger('click')
    const all = w.find('[data-testid="my-instances-revoke-all"]')
    expect(all.text()).toBe('Revoke all 2')
    await all.trigger('click')
    await flushPromises()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(confirmMock).toHaveBeenCalledWith('Revoke 2 devices? They stop sending when their current access runs out; connecting one again is quick.')
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `/api/v1/me/instances/${id(3)}/revoke`,
      `/api/v1/me/instances/${id(4)}/revoke`,
    ])
  })

  it('a failed revoke names the device and the rest still go through', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValue({})
    const w = mountPage(withDevices([unused(3, 'Old box'), unused(4)]))
    vi.stubGlobal('$fetch', fetchMock)
    vi.stubGlobal('confirm', () => true)
    await flushPromises()
    await w.find('[data-testid="my-instances-fold-toggle"]').trigger('click')
    await w.find('[data-testid="my-instances-revoke-all"]').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const toast = w.find('[data-testid="my-instances-toast-err"]').text()
    expect(toast).toContain('Revoked 1 of 2')
    expect(toast).toContain('Old box')
  })

  it('ticking one device narrows the action to the selection', async () => {
    const fetchMock = vi.fn().mockResolvedValue({})
    const w = mountPage(withDevices([unused(3), unused(4)]))
    vi.stubGlobal('$fetch', fetchMock)
    vi.stubGlobal('confirm', () => true)
    await flushPromises()
    await w.find('[data-testid="my-instances-fold-toggle"]').trigger('click')
    await w.find(`[data-testid="instance-select-${id(4)}"]`).setValue(true)
    expect(w.find('[data-testid="my-instances-revoke-all"]').text()).toBe('Revoke the 1 selected')
    await w.find('[data-testid="my-instances-revoke-all"]').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`/api/v1/me/instances/${id(4)}/revoke`])
  })

  it('Cannot send is the only warning, and Fix goes to the steps', async () => {
    const w = mountPage(withDevices([{ ...DEVICE, instance_id: id(5), state: 'cannot-send' }]))
    await flushPromises()
    expect(w.find('[data-testid="account-status"]').text()).toContain('1 cannot send')
    expect(w.find(`[data-testid="instance-fix-${id(5)}"]`).attributes('href')).toBe('#connect-a-tool')
  })
})

describe('My account: Connections (#617)', () => {
  const grant = (id: string, last_used_at: string | null) => ({
    id,
    client_id: `client-${id}`,
    client_name: 'TokenScope plugin',
    client_registered_at: '2026-10-30T00:41:00Z',
    scopes: ['tokenscope.read'],
    scope_labels: ['Read your usage'],
    state: 'active',
    created_at: '2026-10-30T00:41:00Z',
    last_used_at,
    is_emit: false,
  })

  it('an unused connection reads "last used never", not a lone dash', async () => {
    const w = mountPage({ '/api/v1/me/grants': { data: { grants: [grant('a', null), grant('b', '2026-11-10T03:00:00Z')] } } })
    await flushPromises()
    const text = w.text()
    expect(text).toContain('last used never')
    expect(text).not.toMatch(/last used\s*—/)
    expect(text).toMatch(/last used \d{1,2} Nov 2026/)
  })
})
