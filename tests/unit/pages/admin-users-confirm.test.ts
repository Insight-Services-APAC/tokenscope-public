// @vitest-environment happy-dom
/*
 * Teammates (app/pages/admin/users.vue): a role or region change asks first
 * (#543), and the result reads in plain words (#544).
 *
 *   - picking a role opens the dialog and sends NOTHING;
 *   - Cancel sends nothing and puts the select back to the real role;
 *   - Confirm sends the PATCH, and the message names the person and the
 *     role ("Sam Okafor is now a Manager"), never the raw key or an arrow;
 *   - a refused change rolls the row back and says so in role="alert";
 *   - a region pick asks first the same way.
 *
 * Escape and the focus trap are useModalA11y's, behind import.meta.client
 * (unset under plain Vitest): pinned by the static "every role=dialog uses
 * useModalA11y" rule in tests/unit/a11y/wcag-static.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref, watch } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import UsersPage from '../../../app/pages/admin/users.vue'

const ME = '9a1e0000-0000-4000-8000-000000000001'
const SAM = '9a1e0000-0000-4000-8000-000000000002'
const REGION_A = '9a1e0000-0000-4000-8000-00000000000a'
const REGION_B = '9a1e0000-0000-4000-8000-00000000000b'

const USERS = {
  users: [
    {
      id: SAM,
      email: 'sam.okafor@example.com',
      displayName: 'Sam Okafor',
      role: 'developer',
      regionId: REGION_A,
      orgUnitPath: 'a.b',
      orgUnitName: 'Data and AI',
      orgUnitId: '9a1e0000-0000-4000-8000-0000000000c1',
      isActive: true,
      joinedAt: '2026-10-01T00:00:00Z',
      lastSyncAt: null,
    },
  ],
  total: 1,
  adminCount: 1,
  limit: 50,
  offset: 0,
}

const STUBS = {
  UiPageHead: { props: ['title', 'sub'], template: '<div>{{ title }}</div>' },
  UiButton: { template: '<button type="button"><slot /></button>' },
  UiFetchErrorBanner: { template: '<div />' },
  UiAuxFetchError: { template: '<span />' },
  AddTeammateDialog: { template: '<div />' },
  PlaceTeammateDialog: { template: '<div />' },
}

let usersData: { value: typeof USERS }
let fetchCalls: { url: string; opts: { method?: string; body?: unknown } }[]
let fetchImpl: (url: string) => Promise<unknown>

function mountPage(role = 'platform-admin'): VueWrapper {
  fetchCalls = []
  fetchImpl = async () => ({ ok: true })
  vi.stubGlobal('definePageMeta', () => {})
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('useRoute', () => ({ query: {} }))
  vi.stubGlobal('useSession', () => ({
    session: ref({ role, regionId: REGION_A, teammateId: ME }),
  }))
  vi.stubGlobal('useLazyFetch', (url: unknown) => {
    const u = typeof url === 'function' ? (url as () => string)() : String(url)
    const data = u.includes('/admin/regions')
      ? { regions: [{ id: REGION_A, code: 'A', display_name: 'APAC' }, { id: REGION_B, code: 'B', display_name: 'EMEA' }] }
      : u.includes('/admin/org-units')
        ? { nodes: [] }
        : USERS
    const r = ref(structuredClone(data))
    if (data === USERS) usersData = r as unknown as { value: typeof USERS }
    return { data: r, error: ref(null), refresh: vi.fn(async () => {}) }
  })
  vi.stubGlobal('apiErrorDetail', (_e: unknown, fallback: string) => fallback)
  vi.stubGlobal('$fetch', vi.fn(async (url: string, opts: { method?: string; body?: unknown } = {}) => {
    fetchCalls.push({ url, opts })
    return fetchImpl(url)
  }))
  return mount(UsersPage, { global: { stubs: STUBS }, attachTo: document.body })
}

const roleSelect = (w: VueWrapper) => w.find<HTMLSelectElement>(`[data-testid="admin-users-role-select-${SAM}"]`)

async function pickRole(w: VueWrapper, role: string) {
  await roleSelect(w).setValue(role)
  await flushPromises()
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Teammates: a role change asks first', () => {
  it('picking a role opens the dialog and sends nothing', async () => {
    const w = mountPage()
    await flushPromises()
    await pickRole(w, 'manager')
    const dialog = w.find('[data-testid="role-change-dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('Make Sam Okafor a Manager?')
    expect(dialog.text()).toContain('Sam Okafor is a Developer today.')
    expect(dialog.text()).toContain('A Manager also sees reports')
    expect(fetchCalls.filter((c) => c.opts.method === 'PATCH')).toHaveLength(0)
  })

  it('Cancel sends nothing and puts the select back', async () => {
    const w = mountPage()
    await flushPromises()
    await pickRole(w, 'manager')
    await w.find('[data-testid="role-change-cancel"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="role-change-dialog"]').exists()).toBe(false)
    expect(fetchCalls).toHaveLength(0)
    expect(roleSelect(w).element.value).toBe('developer')
  })

  it('Confirm sends the change and says it in words', async () => {
    const w = mountPage()
    await flushPromises()
    await pickRole(w, 'manager')
    await w.find('[data-testid="role-change-confirm"]').trigger('click')
    await flushPromises()
    const patch = fetchCalls.find((c) => c.opts.method === 'PATCH')
    expect(patch?.url).toBe(`/api/v1/admin/users/${SAM}`)
    expect(patch?.opts.body).toEqual({ role: 'manager' })
    const ok = w.find('[data-testid="admin-users-toast-ok"]')
    expect(ok.text()).toBe('Sam Okafor is now a Manager.')
    expect(ok.element.closest('[role="status"]')).not.toBeNull()
    expect(ok.text()).not.toMatch(/→|->|manager\b/)
  })

  it('a refused change rolls back and is announced as an alert', async () => {
    const w = mountPage()
    await flushPromises()
    fetchImpl = async () => { throw new Error('403') }
    await pickRole(w, 'platform-admin')
    expect(w.find('[data-testid="role-change-dialog"]').text()).toContain('Make Sam Okafor an Admin?')
    await w.find('[data-testid="role-change-confirm"]').trigger('click')
    await flushPromises()
    const err = w.find('[data-testid="admin-users-toast-err"]')
    expect(err.text()).toContain('The role change for Sam Okafor was refused.')
    expect(err.element.closest('[role="alert"]')).not.toBeNull()
    expect(roleSelect(w).element.value).toBe('developer')
  })
})

describe('Teammates: Confirm applies only what the dialog described', () => {
  it('a role that changed while the dialog was open is not overwritten', async () => {
    const w = mountPage()
    await flushPromises()
    await pickRole(w, 'platform-admin')
    // Someone else's change arrives (a refresh after another action) while it is open.
    const next = structuredClone(USERS)
    next.users[0]!.role = 'manager'
    usersData.value = next
    await flushPromises()
    await w.find('[data-testid="role-change-confirm"]').trigger('click')
    await flushPromises()
    expect(fetchCalls.filter((c) => c.opts.method === 'PATCH')).toHaveLength(0)
    expect(w.find('[data-testid="admin-users-toast-err"]').text()).toContain('Sam Okafor is a Manager now')
    expect(roleSelect(w).element.value).toBe('manager')
  })
})

describe('Teammates: a row that left the list is not changed', () => {
  it.each([
    ['role', async (w: VueWrapper) => { await pickRole(w, 'manager') }, 'role-change'],
    ['region', async (w: VueWrapper) => {
      await w.find(`[data-testid="admin-users-region-${SAM}"]`).setValue(REGION_B)
      await flushPromises()
    }, 'region-move'],
  ] as const)('%s: Confirm sends nothing when the row is gone', async (_name, open, dialog) => {
    const w = mountPage()
    await flushPromises()
    await open(w)
    // A refresh while the dialog is open no longer lists them (moved or filtered out).
    usersData.value = { ...structuredClone(USERS), users: [], total: 0 }
    await flushPromises()
    await w.find(`[data-testid="${dialog}-confirm"]`).trigger('click')
    await flushPromises()
    expect(fetchCalls.filter((c) => c.opts.method === 'PATCH')).toHaveLength(0)
    expect(w.find('[data-testid="admin-users-toast-err"]').text()).toContain('is no longer in this list')
  })
})

describe('Teammates: a region move asks first', () => {
  it('Cancel sends nothing; Confirm moves and says where', async () => {
    const w = mountPage()
    await flushPromises()
    const region = () => w.find<HTMLSelectElement>(`[data-testid="admin-users-region-${SAM}"]`)
    await region().setValue(REGION_B)
    await flushPromises()
    expect(w.find('[data-testid="region-move-dialog"]').text()).toContain('Move Sam Okafor to EMEA?')
    await w.find('[data-testid="region-move-cancel"]').trigger('click')
    await flushPromises()
    expect(fetchCalls).toHaveLength(0)
    expect(region().element.value).toBe(REGION_A)

    await region().setValue(REGION_B)
    await flushPromises()
    await w.find('[data-testid="region-move-confirm"]').trigger('click')
    await flushPromises()
    expect(fetchCalls[0]).toMatchObject({ url: `/api/v1/admin/users/${SAM}/region`, opts: { method: 'PATCH', body: { region_id: REGION_B } } })
    expect(w.find('[data-testid="admin-users-toast-ok"]').text()).toBe('Sam Okafor moved to EMEA.')
  })
})

describe('Teammates: rows that fit (#637)', () => {
  it('five columns, the name in bold over the email', async () => {
    const w = mountPage()
    await flushPromises()
    const heads = w.findAll('thead th').map((h) => h.text().trim()).filter(Boolean)
    expect(heads).toEqual(['Teammate', 'Role', 'Business Unit', 'Last sync', 'Actions'])
    const cell = w.find(`[data-testid="admin-users-teammate-${SAM}"]`)
    const lines = cell.findAll('div').map((d) => d.text())
    expect(lines).toEqual(['Sam Okafor', 'sam.okafor@example.com'])
  })

  it('a teammate with no name shows the email alone', async () => {
    const w = mountPage()
    await flushPromises()
    usersData.value.users[0]!.displayName = null as unknown as string
    await flushPromises()
    const cell = w.find(`[data-testid="admin-users-teammate-${SAM}"]`)
    expect(cell.findAll('div').map((d) => d.text())).toEqual(['sam.okafor@example.com'])
  })
})
