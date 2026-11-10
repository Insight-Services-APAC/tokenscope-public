// @vitest-environment happy-dom
/*
 * /admin/policies/provider-governance — the races the D1 lazy-read migration
 * made reachable, and the terminal-state affordance.
 *
 * WHY THIS FILE EXISTS. Before the migration every read was `await`ed at setup,
 * so a mutation's refresh could not observe a selection the operator changed
 * mid-flight — the blocking await closed the window. `useLazyFetch` /
 * `useLazyAsyncData` open it: the page keeps rendering, the operator keeps
 * clicking, and the refresh helpers re-read the CURRENT selection. The
 * `enterpriseId`-tagged rate-plan payload and the two disabled selectors are
 * what close it, and nothing pinned any of them.
 *
 * ── THE useLazyAsyncData FAKE (`fakeAsyncData` below) ────────────────────────
 * The guard under test is a claim about ONE Nuxt behaviour, so the fake models
 * that behaviour and nothing more. Read off nuxt 4.5.2,
 * `node_modules/nuxt/dist/app/composables/asyncData.js:305-390`:
 *
 *   - `execute()` does NOT clear `data`. The previous payload stays on screen
 *     for the whole of a watch-triggered refetch. THIS is the window: after
 *     switching to enterprise B, `ratePlansData` still holds A's payload.
 *   - a superseded response never lands (`if (nuxtApp._asyncDataPromises[key]
 *     !== promise) return`), so out-of-order resolution is NOT the hazard.
 *   - on failure `data` is reset to `default()` and `error` is set — `refresh()`
 *     itself RESOLVES. It does not reject.
 *
 * That last fact is why the "a failed reload is not a failed write" case below
 * drives the fake into a rejection Nuxt does not currently produce; the comment
 * on that test says so, and says what it is really pinning.
 *
 * The page's own handlers run for real — `$fetch` is the only thing stubbed —
 * so the `{ enterpriseId, plans }` tagging is exercised, not re-implemented.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, watch, type Ref } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import ProviderGovernancePage from '../../../app/pages/admin/policies/provider-governance.vue'

const ENT_A = '9a1e0000-0000-4000-8000-00000000000a'
const ENT_B = '9a1e0000-0000-4000-8000-00000000000b'

const PLAN_A = {
  id: '9a1e0000-0000-4000-8000-0000000000a1',
  validFrom: '2024-01-01',
  validTo: null,
  flatSeatPriceUsd: 19,
  includedAllowanceUsd: null,
  notes: null,
  retiredAt: null,
  status: 'in-effect' as const,
}
const PLAN_B = {
  id: '9a1e0000-0000-4000-8000-0000000000b1',
  validFrom: '2025-07-01',
  validTo: null,
  flatSeatPriceUsd: 39,
  includedAllowanceUsd: null,
  notes: null,
  retiredAt: null,
  status: 'in-effect' as const,
}
const PLAN_NEW = {
  id: '9a1e0000-0000-4000-8000-0000000000a2',
  validFrom: '2026-03-01',
  validTo: null,
  flatSeatPriceUsd: 21,
  includedAllowanceUsd: null,
  notes: null,
  retiredAt: null,
  status: 'in-effect' as const,
}

// ── the $fetch queue: every imperative call is deferred and resolved by hand ──

interface PendingCall {
  url: string
  method: string
  settle: (value: unknown) => void
  fail: (err: unknown) => void
}
let pending: PendingCall[] = []

function fetchStub(url: string, opts?: { method?: string }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    pending.push({ url, method: opts?.method ?? 'GET', settle: resolve, fail: reject })
  })
}

function take(urlFragment: string, method = 'GET'): PendingCall {
  const i = pending.findIndex((c) => c.url.includes(urlFragment) && c.method === method)
  if (i === -1) {
    throw new Error(
      `no pending ${method} matching "${urlFragment}" — pending: ${pending.map((c) => `${c.method} ${c.url}`).join(' | ') || '(none)'}`,
    )
  }
  return pending.splice(i, 1)[0]!
}

function has(urlFragment: string, method = 'GET'): boolean {
  return pending.some((c) => c.url.includes(urlFragment) && c.method === method)
}

// ── the Nuxt read fakes ──────────────────────────────────────────────────────

interface AsyncOptions {
  default?: () => unknown
  immediate?: boolean
  watch?: Ref<unknown>[]
}

/**
 * Rejection is opt-in and NOT Nuxt's behaviour (see the header): only the
 * "failed reload is not a failed write" test turns it on.
 */
let refreshRejectsWith: unknown = null

function fakeAsyncData(_key: string, handler: () => Promise<unknown>, options: AsyncOptions = {}) {
  const initial = () => (options.default ? options.default() : null)
  const data = ref<unknown>(initial())
  const error = ref<unknown>(null)
  const pendingFlag = ref(false)
  let latest: Promise<void> | null = null

  const execute = (): Promise<void> => {
    pendingFlag.value = true
    // `data` is deliberately NOT cleared — the previous payload stays on screen
    // for the whole refetch, which is the race window this file exists for.
    const p: Promise<void> = Promise.resolve()
      .then(() => {
        if (refreshRejectsWith !== null && latest !== null) throw refreshRejectsWith
        return handler()
      })
      .then((result) => {
        if (p !== latest) return // superseded — a stale response never lands
        data.value = result
        error.value = null
      })
      .catch((e) => {
        if (p !== latest) return
        if (refreshRejectsWith !== null) throw e // opt-in: surface it to the caller
        error.value = e
        data.value = initial()
      })
      .finally(() => {
        if (p === latest) pendingFlag.value = false
      })
    latest = p
    return p
  }

  if (options.immediate !== false) execute()
  for (const src of options.watch ?? []) watch(src, () => void execute())

  return { data, error, pending: pendingFlag, status: ref('idle'), refresh: execute, execute, clear: () => {} }
}

/** Reads whose payload the page only displays; fixtures keyed by URL fragment. */
let lazyFetchFixtures: Record<string, unknown> = {}

function fakeLazyFetch(url: string, options: { default?: () => unknown } = {}) {
  const key = Object.keys(lazyFetchFixtures).find((k) => url.includes(k))
  const seed = key ? lazyFetchFixtures[key] : options.default ? options.default() : null
  return {
    data: ref<unknown>(seed),
    error: ref<unknown>(null),
    pending: ref(false),
    status: ref('idle'),
    refresh: vi.fn(async () => {}),
    execute: vi.fn(async () => {}),
    clear: () => {},
  }
}

// ── stubs ────────────────────────────────────────────────────────────────────

const passThrough = (tag: string) => ({ template: `<div data-stub="${tag}"><slot /></div>` })

const STUBS = {
  UiPageHead: passThrough('page-head'),
  UiCard: passThrough('card'),
  UiEyebrow: passThrough('eyebrow'),
  UiBadge: passThrough('badge'),
  // UiButton declares no `disabled` prop — it falls through to the native
  // element, exactly as in the real component.
  UiButton: {
    inheritAttrs: true,
    template: '<button type="button"><slot /></button>',
  },
  UiFetchErrorBanner: {
    props: ['error', 'label'],
    template: '<div v-if="error" data-testid="fetch-error-banner">{{ label }}</div>',
  },
  AdminPageSkeleton: { template: '<div data-testid="admin-skeleton" />' },
}

const ENTERPRISES = {
  enterprises: [
    { id: ENT_A, provider: 'github', externalId: 'acme', displayName: 'Acme' },
    { id: ENT_B, provider: 'github', externalId: 'globex', displayName: 'Globex' },
    { id: '9a1e0000-0000-4000-8000-00000000000c', provider: 'anthropic', externalId: 'ant', displayName: 'Anthropic co' },
  ],
}

function stubGlobals() {
  vi.stubGlobal('definePageMeta', () => {})
  vi.stubGlobal('useSession', () => ({ session: ref({ role: 'platform-admin' }), ensure: async () => {} }))
  vi.stubGlobal('useLazyFetch', fakeLazyFetch)
  vi.stubGlobal('useLazyAsyncData', fakeAsyncData)
  vi.stubGlobal('$fetch', fetchStub)
}

/**
 * Mount and settle the one read that fires unconditionally at setup (the
 * reporting snapshot). The rate-plan read resolves to `null` without a request
 * while no enterprise is selected, so nothing else is in flight.
 */
async function mountPage(cutoverStatus = 'not_started'): Promise<VueWrapper> {
  lazyFetchFixtures = {
    '/admin/governance-cutover': {
      status: cutoverStatus,
      preflightSnapshot: null,
      preflightVerifiedAt: null,
      activatedAt: null,
      rolledBackAt: null,
    },
    '/admin/reconciliation/enterprises': ENTERPRISES,
    '/admin/diagnostics/governance-unresolved': {
      reachable: true,
      actualSpend: { pendingBackfill: 1, parkedUnresolved: 2 },
      reconciliationRecord: { pendingBackfill: 0, parkedUnresolved: 0 },
      pendingPlacement: { unresolved: 0 },
      bySource: [
        { source: 'anthropic-analytics-api:org-7', count: 2, costUsd: '1.20' },
        { source: 'copilot-seat:acme', count: 1, costUsd: '19.00' },
      ],
    },
    '/admin/governance/personal-subscriptions': {
      month: '2026-08',
      declarations: [],
      totals: {
        effectiveCount: 0,
        activeAtMonthEndCount: 0,
        endedDuringMonthCount: 0,
        effectiveUsageUsd: '0',
        effectiveProviderSpendUsd: '0',
        providerBackedCount: 0,
      },
    },
  }
  stubGlobals()
  const w = mount(ProviderGovernancePage, { global: { stubs: STUBS } })
  await flushPromises()
  take('/admin/reporting-snapshots/').settle(null) // never-recorded month
  await flushPromises()
  return w
}

async function selectEnterprise(w: VueWrapper, id: string) {
  await w.find('[data-testid="copilot-ent-select"]').setValue(id)
  await flushPromises()
}

const RATE_PLAN_SKELETON = '[data-testid="copilot-money-model-card"] [data-testid="admin-skeleton"]'

beforeEach(() => {
  pending = []
  refreshRejectsWith = null
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ── (a) the enterprise-tagged payload ────────────────────────────────────────
/*
 * REVERT: change `ratePlans` back to `ratePlansData.value?.plans ?? null`
 * (drop the `enterpriseId === selectedEnterpriseId` comparison) and the
 * mid-flight assertion below goes red — Acme's 2024-01-01 row renders under
 * Globex while Globex's own history is still being fetched.
 */
describe('rate-plan history is never shown under the wrong enterprise', () => {
  it('switching enterprise mid-request shows the skeleton, not the previous plans', async () => {
    const w = await mountPage()

    await selectEnterprise(w, ENT_A)
    take(`/enterprises/${ENT_A}/copilot-rate-plans`).settle({ plans: [PLAN_A] })
    await flushPromises()
    expect(w.find('[data-testid="rate-plan-history"]').text()).toContain(PLAN_A.validFrom)

    // Globex selected while Acme's history is on screen; Globex's read is in
    // flight, so Nuxt still holds Acme's payload.
    await selectEnterprise(w, ENT_B)
    expect(has(`/enterprises/${ENT_B}/copilot-rate-plans`)).toBe(true)

    expect(w.text()).not.toContain(PLAN_A.validFrom)
    expect(w.find(RATE_PLAN_SKELETON).exists()).toBe(true)

    take(`/enterprises/${ENT_B}/copilot-rate-plans`).settle({ plans: [PLAN_B] })
    await flushPromises()
    expect(w.find('[data-testid="rate-plan-history"]').text()).toContain(PLAN_B.validFrom)
    expect(w.text()).not.toContain(PLAN_A.validFrom)
  })

  /*
   * "In use" used to mean only "not retired", so a plan that had ended, or
   * started later, read as the current rate. The status is the server's
   * (judged for this UTC month by the test billing uses), labelled as is.
   * REVERT: render `p.retiredAt ? 'Retired' : 'In use'` again.
   */
  it('each plan says where it stands this month, as the server judged it', async () => {
    const w = await mountPage()
    await selectEnterprise(w, ENT_A)
    const plans = [
      { ...PLAN_NEW, status: 'starts-later' as const },
      { ...PLAN_A, status: 'in-effect' as const },
      { ...PLAN_B, id: '9a1e0000-0000-4000-8000-0000000000a3', status: 'ended' as const },
      { ...PLAN_B, id: '9a1e0000-0000-4000-8000-0000000000a4', retiredAt: '2026-01-01T00:00:00Z', status: 'retired' as const },
      { ...PLAN_B, id: '9a1e0000-0000-4000-8000-0000000000a5', status: 'never-billed' as const },
    ]
    take(`/enterprises/${ENT_A}/copilot-rate-plans`).settle({ plans })
    await flushPromises()
    const label = (id: string) => w.find(`[data-testid="rate-plan-status-${id}"]`).text()
    expect(label(PLAN_NEW.id)).toBe('Applies from a later month')
    expect(label(PLAN_A.id)).toBe('In effect this month')
    expect(label('9a1e0000-0000-4000-8000-0000000000a3')).toBe('Ended')
    expect(label('9a1e0000-0000-4000-8000-0000000000a4')).toBe('Retired')
    expect(label('9a1e0000-0000-4000-8000-0000000000a5')).toBe('Never billed (no 1st of a month in its dates)')
    expect(w.find('[data-testid="rate-plan-history"]').text()).not.toContain('In use')
  })

  it('the cutover card does not promise that unmatched spend is unchanged by activation', async () => {
    const w = await mountPage()
    const card = w.find('[data-testid="governance-cutover-card"]').text()
    expect(card).not.toContain('nothing changes on the day')
    expect(card).toContain('That checks the settings, not every figure')
    expect(card).toContain('re-judged by a background job')
  })

})

/*
 * NOT PINNED HERE, deliberately: a response arriving after the operator moved
 * on. Nuxt discards a superseded response itself, so a test for it would assert
 * the framework through our page and could not go red on any edit to this file.
 * The reachable hazard is the one above — data KEPT during the refetch.
 */

// ── (b) resolved-empty vs not-loaded ─────────────────────────────────────────
/*
 * REVERT: render the empty row on `!ratePlans?.length` instead of
 * `ratePlans?.length === 0` (or drop the `ratePlans == null` skeleton
 * predicate) and the two halves disagree — an unloaded list claims "no rate
 * plan recorded", which is the D2 failure this predicate exists to prevent.
 */
describe('an unloaded history and an empty one are different answers (D2)', () => {
  it('null renders the skeleton and never the empty row', async () => {
    const w = await mountPage()
    await selectEnterprise(w, ENT_A)

    expect(w.find(RATE_PLAN_SKELETON).exists()).toBe(true)
    expect(w.text()).not.toContain('No rate plan recorded yet')
  })

  it('a resolved empty array renders the empty row and no skeleton', async () => {
    const w = await mountPage()
    await selectEnterprise(w, ENT_A)
    take(`/enterprises/${ENT_A}/copilot-rate-plans`).settle({ plans: [] })
    await flushPromises()

    expect(w.find(RATE_PLAN_SKELETON).exists()).toBe(false)
    expect(w.find('[data-testid="rate-plan-history"]').text()).toContain('No rate plan recorded yet')
  })
})

// ── (c) create refreshes the list ────────────────────────────────────────────

describe('creating a rate plan', () => {
  async function createOn(w: VueWrapper, enterpriseId: string) {
    await w.find('[data-testid="rp-valid-from"]').setValue(PLAN_NEW.validFrom)
    await w.find('[data-testid="rp-create"]').trigger('click')
    await flushPromises()
    return take(`/enterprises/${enterpriseId}/copilot-rate-plans`, 'POST')
  }

  it('refreshes the history and clears the form', async () => {
    const w = await mountPage()
    await selectEnterprise(w, ENT_A)
    take(`/enterprises/${ENT_A}/copilot-rate-plans`).settle({ plans: [PLAN_A] })
    await flushPromises()

    const post = await createOn(w, ENT_A)
    post.settle({ id: PLAN_NEW.id })
    await flushPromises()

    take(`/enterprises/${ENT_A}/copilot-rate-plans`).settle({ plans: [PLAN_A, PLAN_NEW] })
    await flushPromises()

    const history = w.find('[data-testid="rate-plan-history"]').text()
    expect(history).toContain(PLAN_NEW.validFrom)
    expect(history).toContain(PLAN_A.validFrom)
    expect((w.find('[data-testid="rp-valid-from"]').element as HTMLInputElement).value).toBe('')
    expect(w.find('[data-testid="rate-plan-error"]').exists()).toBe(false)
  })

  /*
   * The enterprise select is LOCKED for the whole write, so the refresh cannot
   * target an enterprise other than the one just written to.
   *
   * REVERT: drop `:disabled="ratePlansBusy || repullBusy"` from the select and
   * this goes red — and with it the operator can switch to Globex mid-create
   * and be shown Globex's history as confirmation of a write to Acme.
   */
  it('locks the enterprise selector until the write and its reload are done', async () => {
    const w = await mountPage()
    await selectEnterprise(w, ENT_A)
    take(`/enterprises/${ENT_A}/copilot-rate-plans`).settle({ plans: [PLAN_A] })
    await flushPromises()

    const select = w.find('[data-testid="copilot-ent-select"]')
    expect(select.attributes('disabled')).toBeUndefined()

    const post = await createOn(w, ENT_A)
    expect(w.find('[data-testid="copilot-ent-select"]').attributes('disabled')).toBeDefined()

    post.settle({ id: PLAN_NEW.id })
    await flushPromises()
    // still locked: the reload is in flight and it re-reads the selection
    expect(w.find('[data-testid="copilot-ent-select"]').attributes('disabled')).toBeDefined()

    take(`/enterprises/${ENT_A}/copilot-rate-plans`).settle({ plans: [PLAN_A, PLAN_NEW] })
    await flushPromises()
    expect(w.find('[data-testid="copilot-ent-select"]').attributes('disabled')).toBeUndefined()
  })

  it('reports a refused write as a failed write', async () => {
    const w = await mountPage()
    await selectEnterprise(w, ENT_A)
    take(`/enterprises/${ENT_A}/copilot-rate-plans`).settle({ plans: [PLAN_A] })
    await flushPromises()

    const post = await createOn(w, ENT_A)
    post.fail({ data: { data: { detail: 'validFrom overlaps an existing plan' } } })
    await flushPromises()

    expect(w.find('[data-testid="rate-plan-error"]').text()).toContain('validFrom overlaps an existing plan')
    // the form keeps what was typed — nothing was written
    expect((w.find('[data-testid="rp-valid-from"]').element as HTMLInputElement).value).toBe(PLAN_NEW.validFrom)
    expect(has(`/enterprises/${ENT_A}/copilot-rate-plans`)).toBe(false)
  })

  /*
   * A COMMITTED WRITE IS NEVER REPORTED AS A FAILED ONE.
   *
   * `refreshRejectsWith` makes the reload throw. Nuxt's own `refresh()` does
   * not reject today (header), so what this pins is the TRY-BLOCK BOUNDARY: the
   * reload sits outside the write's catch. That boundary is what a future edit
   * would breach — swap `refreshRatePlans()` for a bare `$fetch`, which does
   * reject, and the old shape would have told the operator their committed
   * plan failed to save.
   *
   * REVERT: put `await refreshRatePlans()` back inside the create's `try` and
   * this goes red with "Failed to create rate plan".
   */
  it('a failed reload after a committed write is not reported as a failed write', async () => {
    const w = await mountPage()
    await selectEnterprise(w, ENT_A)
    take(`/enterprises/${ENT_A}/copilot-rate-plans`).settle({ plans: [PLAN_A] })
    await flushPromises()

    const post = await createOn(w, ENT_A)
    // A detail-less failure, so `apiErrorDetail` falls back to the message this
    // call site chose — which is what the assertion is about.
    refreshRejectsWith = { data: {} }
    post.settle({ id: PLAN_NEW.id })
    await flushPromises()

    const err = w.find('[data-testid="rate-plan-error"]').text()
    expect(err).not.toContain('Failed to create rate plan')
    expect(err).toContain('Rate plan created')
  })
})

// ── the same class, after the in-flight window closes ────────────────────────
/*
 * REVERT: drop the `watch(selectedEnterpriseId, …)` reset and this goes red —
 * Acme's re-pull counts stay on screen under Globex, reading as Globex's.
 */
describe('a mutation outcome does not survive the enterprise it belongs to', () => {
  it('clears the re-pull result when the selection moves', async () => {
    const w = await mountPage()
    await selectEnterprise(w, ENT_A)
    take(`/enterprises/${ENT_A}/copilot-rate-plans`).settle({ plans: [PLAN_A] })
    await flushPromises()

    await w.find('[data-testid="repull-reason"]').setValue('provider corrected the month')
    await w.find('[data-testid="trigger-repull"]').trigger('click')
    await flushPromises()
    take(`/enterprises/${ENT_A}/copilot-bill-repull`, 'POST').settle({
      month: '2026-07',
      result: {
        orgRowsWritten: 3,
        residualRowsWritten: 1,
        overageAllocationsComputed: 2,
        overageAllocationsUnallocated: 0,
        enterprisesErrored: 0,
      },
    })
    await flushPromises()
    expect(w.find('[data-testid="repull-result"]').text()).toContain('3 org row(s)')

    await selectEnterprise(w, ENT_B)
    expect(w.find('[data-testid="repull-result"]').exists()).toBe(false)
  })
})

// ── the reporting-snapshot month, same class ─────────────────────────────────
/*
 * REVERT: drop `:disabled="periodBusy"` from the month input and the operator
 * can switch months between the POST and `loadPeriod()`, so the "recorded"
 * badge they are shown belongs to a month they did not just record.
 */
describe('recording a month locks the month it is recording', () => {
  it('the month input is disabled for the whole write, and released after', async () => {
    const w = await mountPage()
    const month = () => w.find('[data-testid="period-month"]')
    expect(month().attributes('disabled')).toBeUndefined()

    await w.find('[data-testid="close-period"]').trigger('click')
    await w.find('[data-testid="period-record-confirm"]').trigger('click')
    await flushPromises()
    expect(month().attributes('disabled')).toBeDefined()

    take('/admin/reporting-snapshots/', 'POST').settle({ ok: true })
    await flushPromises()
    expect(month().attributes('disabled')).toBeDefined() // the reload re-reads it

    take('/admin/reporting-snapshots/').settle(null)
    await flushPromises()
    expect(month().attributes('disabled')).toBeUndefined()
  })
})

// ── preflight in a state the server refuses ──────────────────────────────────
/*
 * server/governance/cutover.ts:244 is the only state guard on preflight:
 * `activated` → CutoverError('wrong-state') → 409. `rolled_back` is explicitly
 * a state preflight RE-RUNS from (the state-machine comment at the top of that
 * file), so it must stay enabled — disabling it there would break the recovery
 * path, not fix an affordance.
 *
 * REVERT: drop `|| cutover?.status === 'activated'` and the first case goes red.
 */
describe('Run preflight is offered only where the server accepts it', () => {
  it.each([
    ['not_started', false],
    ['preflight_verified', false],
    ['rolled_back', false],
    ['activated', true],
  ])('status %s → disabled: %s', async (status, expected) => {
    const w = await mountPage(status)
    const disabled = w.find('[data-testid="run-preflight"]').attributes('disabled') !== undefined
    expect(disabled).toBe(expected)
  })

  it('says why, when it is off', async () => {
    const w = await mountPage('activated')
    expect(w.find('[data-testid="preflight-blocked-note"]').text()).toMatch(/roll back first/i)
  })
})

// ── one-way actions ask first (#543) ─────────────────────────────────────────
/*
 * REVERT: point either button's @click back at activate / closePeriod and the
 * "Cancel sends nothing" cases go red (the POST is already pending).
 */
describe('Activate and Record this month ask first', () => {
  it('Activate opens a dialog; Cancel sends nothing', async () => {
    const w = await mountPage('preflight_verified')
    await w.find('[data-testid="activate-governance"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="governance-activate-dialog"]').text()).toContain('billing setting of its registered enterprise or organisation')
    expect(has('/governance-cutover/activate', 'POST')).toBe(false)
    await w.find('[data-testid="governance-activate-cancel"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="governance-activate-dialog"]').exists()).toBe(false)
    expect(has('/governance-cutover/activate', 'POST')).toBe(false)
  })

  it('Activate confirmed sends the activation', async () => {
    const w = await mountPage('preflight_verified')
    await w.find('[data-testid="activate-governance"]').trigger('click')
    await w.find('[data-testid="governance-activate-confirm"]').trigger('click')
    await flushPromises()
    expect(has('/governance-cutover/activate', 'POST')).toBe(true)
  })

  it('Record this month names the month; Cancel sends nothing', async () => {
    const w = await mountPage()
    await w.find('[data-testid="close-period"]').trigger('click')
    await flushPromises()
    // The month in words ("October 2026"), never the raw YYYY-MM.
    const title = w.find('[data-testid="period-record-dialog"] h2').text()
    expect(title).toMatch(/^Record [A-Z][a-z]+ \d{4}\?$/)
    await w.find('[data-testid="period-record-cancel"]').trigger('click')
    await flushPromises()
    expect(has('/admin/reporting-snapshots/', 'POST')).toBe(false)
  })
})

// ── plain words (#545) ───────────────────────────────────────────────────────
describe('Provider governance reads in plain words', () => {
  it.each([
    ['not_started', 'Not started'],
    ['preflight_verified', 'Preflight passed'],
    ['activated', 'Active'],
    ['rolled_back', 'Rolled back'],
  ])('status %s shows as %s', async (status, label) => {
    const w = await mountPage(status)
    expect(w.find('[data-testid="cutover-status-badge"]').text()).toBe(label)
  })

  it('shows no snake_case or kebab-case word, no column name and no em dash', async () => {
    const w = await mountPage()
    const text = w.text()
    expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/)
    expect(text).not.toMatch(/\b[a-z]+-[a-z]+-[a-z-]+\b/)
    expect(text).not.toMatch(/Governance-unresolved|GOVERNANCE-UNRESOLVED/i)
    // The cutover copy used to print the column name as code.
    expect(w.find('[data-testid="governance-cutover-card"]').findAll('code')).toHaveLength(0)
    expect(text).not.toContain('\u2014')
    expect(text).toContain('Spend we could not match to a provider account')
    // The source keys carry the account id: the words keep it, the key does not show.
    expect(text).toContain('Anthropic organisation org-7')
    expect(text).toContain('GitHub Copilot seats, organisation acme')
    expect(text).not.toMatch(/anthropic-analytics-api|copilot-seat/)
  })
})
