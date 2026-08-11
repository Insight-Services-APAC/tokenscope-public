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
import WorkerControlRow, { type WorkerControlRowData } from '../../../app/components/admin/WorkerControlRow.vue'

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

const mountRow = (worker: WorkerControlRowData, busy = false) =>
  mount(WorkerControlRow, { props: { worker, busy }, global: { stubs: STUBS } })

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

  it('emits toggle on click, and the button is inert while busy', () => {
    const w = mountRow(row())
    w.find('[data-testid="worker-toggle-button"]').trigger('click')
    expect(w.emitted('toggle')).toHaveLength(1)

    const busy = mountRow(row(), true)
    expect(busy.find('[data-testid="worker-toggle-button"]').attributes('disabled')).toBeDefined()
  })
})
