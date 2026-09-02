// @vitest-environment happy-dom
/*
 * The worker-run drill-down on Admin → Workers (docs/design/alert-diagnosability
 * .md D5).
 *
 * What is pinned: the SLOW run is findable from the list, and a condition's
 * severity, reason, count and correlation id survive to the screen — including
 * for a run recorded before D1 added the last two, which must degrade to an
 * em-dash, never to a crash or a claim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import WorkerRunsPanel from '../../../app/components/admin/WorkerRunsPanel.vue'
import WorkerRunDetail, { type WorkerRunDetailData } from '../../../app/components/admin/WorkerRunDetail.vue'

const UiBadge = { props: ['kind'], template: '<span :data-kind="kind"><slot /></span>' }
const UiFetchErrorBanner = {
  props: ['error', 'label'],
  template: '<div v-if="error" data-testid="fetch-error-banner">{{ label }}</div>',
}
const COMPONENTS = { UiBadge, UiFetchErrorBanner, AdminWorkerRunDetail: WorkerRunDetail }

const RUN_A = '9a1e0000-0000-4000-8000-000000000001'
const RUN_B = '9a1e0000-0000-4000-8000-000000000002'
const RUN_C = '9a1e0000-0000-4000-8000-000000000003'

function listRow(over: Record<string, unknown> = {}) {
  return {
    id: RUN_A,
    worker: 'ops-alert',
    status: 'success',
    startedAt: '2026-08-28T05:09:00.000Z',
    finishedAt: '2026-08-28T05:09:05.293Z',
    durationMs: 288,
    hasError: false,
    warnings: [] as string[],
    ...over,
  }
}

function detail(over: Partial<WorkerRunDetailData> = {}): WorkerRunDetailData {
  return {
    id: RUN_A,
    worker: 'ops-alert',
    status: 'success',
    startedAt: '2026-08-28T05:09:00.000Z',
    finishedAt: '2026-08-28T05:09:05.293Z',
    durationMs: 5293,
    error: null,
    result: null,
    warnings: [],
    ...over,
  }
}

const mountDetail = (run: WorkerRunDetailData) =>
  mount(WorkerRunDetail, { props: { run }, global: { components: COMPONENTS } })

describe('AdminWorkerRunDetail — the evidence a run recorded', () => {
  it('renders a condition as condition · severity · reason · count', () => {
    const w = mountDetail(detail({
      result: {
        disabled: false,
        conditions: {
          'telemetry-read': { severity: 'critical', reason: 'probe-timeout' },
          'inbox-aging': { severity: 'warning', reason: 'items-aged', count: 3 },
        },
      },
    }))
    const critical = w.find('[data-testid="worker-run-condition-telemetry-read"]')
    expect(critical.text()).toContain('telemetry-read')
    expect(critical.text()).toContain('critical')
    expect(critical.text()).toContain('probe-timeout')
    expect(critical.find('[data-kind]').attributes('data-kind')).toBe('rag-red')

    const warning = w.find('[data-testid="worker-run-condition-inbox-aging"]')
    expect(warning.text()).toContain('items-aged')
    expect(warning.text()).toContain('3')
    expect(warning.find('[data-kind]').attributes('data-kind')).toBe('rag-amber')
  })

  it('shows a correlation id whole, in a selectable monospace form', () => {
    const w = mountDetail(detail({
      result: { conditions: { 'telemetry-read': { severity: 'critical', reason: 'probe-failed', correlationId: 'abc-123-def-456' } } },
    }))
    const row = w.find('[data-testid="worker-run-correlation-telemetry-read"]')
    expect(row.exists()).toBe(true)
    const code = row.find('code')
    expect(code.text()).toBe('abc-123-def-456')
    // Selectable in one click — the operator pastes this into the provider console.
    expect(code.classes()).toContain('select-all')
  })

  it('a run recorded BEFORE D1 has no reason and no correlation id — em-dash, no crash', () => {
    // The pre-D1 shape is exactly `{ severity, count? }`. It must still render
    // the severity it does have, and must not imply a reason it never carried.
    const w = mountDetail(detail({ result: { conditions: { 'worker-fleet': { severity: 'critical', count: 2 } } } }))
    const row = w.find('[data-testid="worker-run-condition-worker-fleet"]')
    expect(row.text()).toContain('critical')
    expect(row.text()).toContain('—')
    expect(row.text()).toContain('2')
    expect(w.find('[data-testid="worker-run-correlation-worker-fleet"]').exists()).toBe(false)
  })

  it('a severity outside the vocabulary still renders (display, not validation)', () => {
    const w = mountDetail(detail({ result: { conditions: { 'channel-test': { severity: 'info' } } } }))
    const row = w.find('[data-testid="worker-run-condition-channel-test"]')
    expect(row.text()).toContain('info')
    expect(row.find('[data-kind]').attributes('data-kind')).toBe('neutral')
  })

  it('an ops-alert run that raised NOTHING says so — it is not an empty screen', () => {
    const w = mountDetail(detail({ result: { disabled: false, conditions: {}, sent: 0 } }))
    expect(w.find('[data-testid="worker-run-conditions-empty"]').text()).toContain('No conditions raised')
    expect(w.find('[data-testid="worker-run-conditions"]').exists()).toBe(false)
  })

  it('another worker\'s arbitrary result renders — scalars as pairs, nesting as JSON', () => {
    // Never `[object Object]`: this component does not know these shapes and
    // does not pretend to.
    const w = mountDetail(detail({
      worker: 'reconciliation-sync',
      result: { scopesRun: 4, ok: true, skipped: null, byScope: { anthropic: 2, github: 2 } },
    }))
    const scalars = w.find('[data-testid="worker-run-result-scalars"]').text()
    expect(scalars).toContain('scopesRun')
    expect(scalars).toContain('4')
    expect(scalars).toContain('true')
    expect(w.text()).not.toContain('[object Object]')
    const json = w.find('[data-testid="worker-run-result-json"]')
    expect(json.text()).toContain('byScope')
    expect(json.find('pre').text()).toContain('"anthropic": 2')
  })

  it('a `conditions` key that is NOT the shape we understand falls back to JSON', () => {
    // Tolerating an unexpected shape matters more than rendering it prettily —
    // the alternative is a table of undefineds over a real incident.
    const w = mountDetail(detail({ result: { conditions: ['telemetry-read'] } }))
    expect(w.find('[data-testid="worker-run-conditions"]').exists()).toBe(false)
    expect(w.find('[data-testid="worker-run-conditions-empty"]').exists()).toBe(false)
    expect(w.find('[data-testid="worker-run-result-json"]').text()).toContain('telemetry-read')
  })

  it('a result that is not an object at all still renders as JSON', () => {
    const w = mountDetail(detail({ result: ['a', 'b'] }))
    expect(w.find('[data-testid="worker-run-result-raw"]').text()).toContain('"a"')
  })

  it('no result and no error says so, rather than showing an empty panel', () => {
    const w = mountDetail(detail({ result: null }))
    expect(w.find('[data-testid="worker-run-result-empty"]').exists()).toBe(true)
  })

  it('keeps the exact millisecond count beside the rounded one', () => {
    // 5 293 ms against a 5 000 ms budget IS the diagnosis; "5.3s" alone loses
    // the comparison to the budget.
    expect(mountDetail(detail({ durationMs: 5293 })).find('[data-testid="worker-run-duration"]').text())
      .toBe('5.3s (5,293 ms)')
    // Sub-second needs no second form — it is already exact.
    expect(mountDetail(detail({ durationMs: 288 })).find('[data-testid="worker-run-duration"]').text())
      .toBe('288ms')
    expect(mountDetail(detail({ durationMs: null })).find('[data-testid="worker-run-duration"]').text())
      .toBe('—')
  })

  it('surfaces the error text and the derived warnings', () => {
    const w = mountDetail(detail({ status: 'failure', error: 'ETIMEDOUT reading the joiner table', warnings: ['2 scopes errored'] }))
    expect(w.find('[data-testid="worker-run-error"]').text()).toContain('ETIMEDOUT')
    expect(w.find('[data-testid="worker-run-warnings"]').text()).toContain('2 scopes errored')
  })
})

describe('AdminWorkerRunsPanel — finding the run that paged you', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const mountPanel = (worker = 'ops-alert') =>
    mount(WorkerRunsPanel, { props: { worker }, global: { components: COMPONENTS } })

  it('reads only its own worker, only on mount, and only 30 runs', async () => {
    // On demand by construction: this component is mounted by a click, so the
    // workers page still awaits no network call at setup (nav D1).
    fetchMock.mockResolvedValue({ runs: [listRow()] })
    const w = mountPanel()
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/worker-runs', {
      query: { worker: 'ops-alert', limit: 30 },
    })
    expect(w.find(`[data-testid="worker-run-${RUN_A}"]`).exists()).toBe(true)
  })

  it('marks the SLOWEST run of those listed — the one a p50 hides', async () => {
    fetchMock.mockResolvedValue({
      runs: [
        listRow({ id: RUN_A, durationMs: 288 }),
        listRow({ id: RUN_B, durationMs: 5293 }),
        listRow({ id: RUN_C, durationMs: 2878 }),
      ],
    })
    const w = mountPanel()
    await flushPromises()
    const marked = w.findAll('[data-testid="worker-run-slowest"]')
    expect(marked).toHaveLength(1)
    const slowRow = w.find(`[data-testid="worker-run-${RUN_B}"]`)
    expect(slowRow.find('[data-testid="worker-run-slowest"]').exists()).toBe(true)
    expect(slowRow.text()).toContain('5.3s')
    // The cue is "the max of what you are looking at", not an invented threshold.
    expect(slowRow.find('[data-testid="worker-run-slowest"]').attributes('title'))
      .toBe('Slowest of the runs listed here')
  })

  it('a run with NO recorded duration cannot be the slowest', async () => {
    // A reaped row has no duration_ms. Treating a missing number as the maximum
    // would point the operator at the one run that measured nothing.
    fetchMock.mockResolvedValue({
      runs: [listRow({ id: RUN_A, durationMs: null, status: 'failure' }), listRow({ id: RUN_B, durationMs: 1200 })],
    })
    const w = mountPanel()
    await flushPromises()
    expect(w.find(`[data-testid="worker-run-${RUN_A}"]`).find('[data-testid="worker-run-slowest"]').exists()).toBe(false)
    expect(w.find(`[data-testid="worker-run-${RUN_B}"]`).find('[data-testid="worker-run-slowest"]').exists()).toBe(true)
    expect(w.find(`[data-testid="worker-run-${RUN_A}"]`).text()).toContain('—')
  })

  it('when NO run has a duration, nothing is marked slowest', async () => {
    /*
     * The assertion that actually holds the guard up. In a mixed list the
     * arithmetic picks the measured run either way, so dropping the null check
     * costs nothing there — it only shows here, where the marker would land on
     * a run that measured nothing at all.
     */
    fetchMock.mockResolvedValue({
      runs: [listRow({ id: RUN_A, durationMs: null }), listRow({ id: RUN_B, durationMs: null })],
    })
    const w = mountPanel()
    await flushPromises()
    expect(w.findAll('[data-testid="worker-run-slowest"]')).toHaveLength(0)
  })

  it('flags an error recorded on a run the ledger did not mark failed', async () => {
    fetchMock.mockResolvedValue({ runs: [listRow({ status: 'success', hasError: true, warnings: ['1 scope errored'] })] })
    const w = mountPanel()
    await flushPromises()
    const text = w.find(`[data-testid="worker-run-${RUN_A}"]`).text()
    expect(text).toContain('error')
    expect(text).toContain('1 warning')
  })

  it('opening a run loads its detail and renders the conditions', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === '/api/v1/admin/worker-runs'
        ? Promise.resolve({ runs: [listRow({ durationMs: 5293 })] })
        : Promise.resolve(detail({
            durationMs: 5293,
            result: { conditions: { 'telemetry-read': { severity: 'critical', reason: 'probe-timeout' } } },
          })),
    )
    const w = mountPanel()
    await flushPromises()
    await w.find(`[data-testid="worker-run-${RUN_A}"] button`).trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/v1/admin/worker-runs/${RUN_A}`)
    const detailEl = w.find(`[data-testid="worker-run-detail-${RUN_A}"]`)
    expect(detailEl.text()).toContain('telemetry-read')
    expect(detailEl.text()).toContain('probe-timeout')
    expect(detailEl.text()).toContain('5.3s (5,293 ms)')
  })

  it('clicking the open run again closes it', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === '/api/v1/admin/worker-runs' ? Promise.resolve({ runs: [listRow()] }) : Promise.resolve(detail()),
    )
    const w = mountPanel()
    await flushPromises()
    const btn = () => w.find(`[data-testid="worker-run-${RUN_A}"] button`)
    await btn().trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="worker-run-detail"]').exists()).toBe(true)
    await btn().trigger('click')
    expect(w.find('[data-testid="worker-run-detail"]').exists()).toBe(false)
  })

  it('a failed detail read says so instead of leaving the row blank', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === '/api/v1/admin/worker-runs'
        ? Promise.resolve({ runs: [listRow()] })
        : Promise.reject(new Error('404')),
    )
    const w = mountPanel()
    await flushPromises()
    await w.find(`[data-testid="worker-run-${RUN_A}"] button`).trigger('click')
    await flushPromises()
    expect(w.find(`[data-testid="worker-run-detail-${RUN_A}"]`).text()).toContain('Failed to load run detail')
  })

  it('no runs is stated as no runs — never as a broken panel', async () => {
    fetchMock.mockResolvedValue({ runs: [] })
    const w = mountPanel('archive-ledger')
    await flushPromises()
    expect(w.text()).toContain('No runs recorded for this worker')
  })

  it('a failed list read shows the retry banner, not an empty list', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const w = mountPanel()
    await flushPromises()
    expect(w.find('[data-testid="fetch-error-banner"]').exists()).toBe(true)
    expect(w.text()).not.toContain('No runs recorded for this worker')
  })
})
