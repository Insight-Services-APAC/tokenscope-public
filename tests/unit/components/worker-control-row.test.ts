// @vitest-environment happy-dom
/*
 * WorkerControlRow — what the admin card is allowed to CLAIM about a worker.
 *
 * These assertions exist because the inline version of this markup shipped two
 * false claims at once: a cron cadence for a worker with no cron job, and an
 * enable/disable toggle for a worker that never ticks. Neither could fail a test
 * while the markup lived inside an unmountable page.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkerControlRow, { type WorkerControlRowData, type WorkerDutyCycleSummary } from '../../../app/components/admin/WorkerControlRow.vue'

const STUBS = {
  UiBadge: { props: ['kind'], template: '<span :data-kind="kind"><slot /></span>' },
  UiButton: {
    props: ['kind', 'size', 'disabled'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
}

function row(over: Partial<WorkerControlRowData> = {}): WorkerControlRowData {
  return {
    name: 'budget-alert',
    scheduled: true,
    unscheduledReason: null,
    recommendedCron: '0 * * * *',
    enabled: true,
    reason: null,
    ...over,
  }
}

const mountRow = (worker: WorkerControlRowData, busy = false, summary: WorkerDutyCycleSummary | null = null) =>
  mount(WorkerControlRow, { props: { worker, busy, summary }, global: { stubs: STUBS } })

describe('WorkerControlRow', () => {
  it('a SCHEDULED worker shows its live cron and an On/Off state', () => {
    const w = mountRow(row())
    expect(w.find('[data-testid="worker-cron"]').text()).toBe('0 * * * *')
    expect(w.find('[data-testid="worker-state-badge"]').text()).toBe('On')
    expect(w.find('[data-testid="worker-unscheduled-badge"]').exists()).toBe(false)
  })

  it('an UNSCHEDULED worker shows NO cron — it has no job to run on', () => {
    const w = mountRow(row({ name: 'archive-ledger', scheduled: false, recommendedCron: null, unscheduledReason: 'blocked on a cold-fallback' }))
    expect(w.find('[data-testid="worker-cron"]').exists()).toBe(false)
    expect(w.text()).toContain('this worker never runs')
    expect(w.text()).toContain('blocked on a cold-fallback')
  })

  it('an UNSCHEDULED worker offers NO toggle and claims no On/Off state', () => {
    // The Copilot finding: On + a Disable button implies control over something
    // that never ticks. Enabling it would change nothing observable.
    const w = mountRow(row({ scheduled: false, recommendedCron: null, unscheduledReason: 'x' }))
    expect(w.find('[data-testid="worker-toggle-button"]').exists()).toBe(false)
    expect(w.find('[data-testid="worker-state-badge"]').exists()).toBe(false)
    expect(w.find('[data-testid="worker-unscheduled-badge"]').text()).toBe('Not scheduled')
  })

  it('a scheduled worker still renders its cron even when DISABLED', () => {
    // Disabled is not unscheduled: the cron keeps firing and records a skipped run,
    // so hiding the cadence here would lose the distinction the card exists to show.
    const w = mountRow(row({ enabled: false, reason: 'false-positive rate unmeasured' }))
    expect(w.find('[data-testid="worker-cron"]').text()).toBe('0 * * * *')
    expect(w.find('[data-testid="worker-state-badge"]').text()).toBe('Off')
    expect(w.find('[data-testid="worker-toggle-button"]').text()).toBe('Enable')
    expect(w.text()).toContain('false-positive rate unmeasured')
  })

  it('an UNSCHEDULED worker does not surface a stale disabled-reason', () => {
    // A row can persist from before the API refused to write one. The reason
    // explains why a RUNNING worker was switched off; for one that never runs it
    // asserts a distinction that does not exist.
    const w = mountRow(row({
      scheduled: false,
      recommendedCron: null,
      unscheduledReason: 'blocked on a cold-fallback',
      enabled: false,
      reason: 'stale row from before the guard',
    }))
    expect(w.text()).not.toContain('stale row from before the guard')
    expect(w.text()).toContain('blocked on a cold-fallback')
  })

  it('renders no literal "null" when the unscheduled reason is missing', () => {
    // Vue interpolates null as '', so this holds — pinned because the text is
    // built by concatenation, where a future refactor could reintroduce it.
    const w = mountRow(row({ scheduled: false, recommendedCron: null, unscheduledReason: null }))
    expect(w.text()).not.toContain('null')
    expect(w.text()).toContain('this worker never runs')
  })

  it('renders the 24 h duty-cycle columns: runs, p50 (s), max (s), busy (mm:ss)', () => {
    // O4/dr-H7 — this row is the summary's specified consumer. 3400 ms shows a
    // decimal under 10 s; 725 000 ms = 12:05 proves the mm:ss branch.
    const w = mountRow(row(), false, { runs: 12, p50Ms: 3400, maxMs: 9000, busyMs: 725_000 })
    expect(w.find('[data-testid="worker-runs-24h"]').text()).toBe('12 runs')
    expect(w.find('[data-testid="worker-p50-24h"]').text()).toBe('p50 3.4s')
    expect(w.find('[data-testid="worker-max-24h"]').text()).toBe('max 9.0s')
    expect(w.find('[data-testid="worker-busy-24h"]').text()).toBe('busy 12:05')
  })

  it('renders MAX even when the median looks healthy — the incident case', () => {
    /*
     * alert-diagnosability D5: the operator paged at 05:09 saw `95 runs · p50
     * 1.7s` and nothing else, while the run that raised the alert took 5 293 ms
     * against a 5 000 ms budget. A median cannot show a tail; this assertion is
     * the reason the column exists.
     */
    const w = mountRow(row({ name: 'ops-alert' }), false, {
      runs: 95, p50Ms: 1700, maxMs: 5293, busyMs: 200_000,
    })
    expect(w.find('[data-testid="worker-p50-24h"]').text()).toBe('p50 1.7s')
    expect(w.find('[data-testid="worker-max-24h"]').text()).toBe('max 5.3s')
  })

  it('NO summary (never completed a run in 24 h) renders em-dashes, not zeros', () => {
    const w = mountRow(row())
    expect(w.find('[data-testid="worker-runs-24h"]').text()).toBe('—')
    expect(w.find('[data-testid="worker-p50-24h"]').text()).toBe('—')
    expect(w.find('[data-testid="worker-max-24h"]').text()).toBe('—')
    expect(w.find('[data-testid="worker-busy-24h"]').text()).toBe('—')
  })

  it('a null p50 (only reaped, duration-less runs) dashes p50 and max but keeps runs', () => {
    const w = mountRow(row(), false, { runs: 1, p50Ms: null, maxMs: null, busyMs: 60_000 })
    expect(w.find('[data-testid="worker-runs-24h"]').text()).toBe('1 run')
    expect(w.find('[data-testid="worker-p50-24h"]').text()).toBe('p50 —')
    expect(w.find('[data-testid="worker-max-24h"]').text()).toBe('max —')
    // exactly one minute exercises the s → mm:ss boundary
    expect(w.find('[data-testid="worker-busy-24h"]').text()).toBe('busy 1:00')
  })

  it('offers the recent-runs disclosure on EVERY worker, scheduled or not', () => {
    // The run ledger is a record, not a control: an unscheduled worker's empty
    // run list is itself the evidence for "this worker never runs".
    for (const w of [mountRow(row()), mountRow(row({ scheduled: false, recommendedCron: null, unscheduledReason: 'x' }))]) {
      expect(w.find('[data-testid="worker-runs-toggle"]').exists()).toBe(true)
    }
  })

  it('the runs disclosure emits toggle-runs and reports its state to AT', async () => {
    const w = mountRow(row())
    const btn = w.find('[data-testid="worker-runs-toggle"]')
    expect(btn.attributes('aria-expanded')).toBe('false')
    expect(btn.text()).toBe('Recent runs')
    await btn.trigger('click')
    expect(w.emitted('toggle-runs')).toHaveLength(1)
    // The parent owns which worker is open, so the label follows the prop.
    await w.setProps({ runsOpen: true })
    expect(w.find('[data-testid="worker-runs-toggle"]').attributes('aria-expanded')).toBe('true')
    expect(w.find('[data-testid="worker-runs-toggle"]').text()).toBe('Hide runs')
  })

  it('the runs slot is mounted ONLY while open — the panel fetches on demand', async () => {
    // admin-nav-responsiveness D1: nothing on this page may read over the
    // network at setup. A panel rendered eagerly (hidden by CSS, say) would
    // fetch for every worker on every visit.
    const w = mount(WorkerControlRow, {
      props: { worker: row(), runsOpen: false },
      slots: { runs: '<div data-testid="panel-stub">runs</div>' },
      global: { stubs: STUBS },
    })
    expect(w.find('[data-testid="panel-stub"]').exists()).toBe(false)
    await w.setProps({ runsOpen: true })
    expect(w.find('[data-testid="panel-stub"]').exists()).toBe(true)
  })

  it('emits toggle on click, and the button is inert while busy', () => {
    const w = mountRow(row())
    w.find('[data-testid="worker-toggle-button"]').trigger('click')
    expect(w.emitted('toggle')).toHaveLength(1)

    const busy = mountRow(row(), true)
    expect(busy.find('[data-testid="worker-toggle-button"]').attributes('disabled')).toBeDefined()
  })
})
