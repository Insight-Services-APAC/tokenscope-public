// @vitest-environment happy-dom
/*
 * TopupLog — append-only invariant unit tests.
 *
 * The list rendering must never expose an Edit / Delete affordance —
 * top-ups are immutable allocation rows by design (audit-trail
 * integrity). Submitting the inline form emits `add` with the typed
 * payload; submit is disabled when budget is invalid or the date
 * range is degenerate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import TopupLog, { type TopupRow } from '../../../app/components/allocator/TopupLog.vue'
import { stubServerClock } from '../../helpers/server-clock'
import { resolveServerClock } from '../../../shared/reports/clock'

beforeEach(() => {
  stubServerClock('2026-10-15T12:00:00Z')
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const sampleTopup: TopupRow = {
  id: 't1',
  budget_usd: '500.00',
  effective: '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)',
  created_at: '2026-05-15T10:00:00Z',
  actor_display_name: 'Anil Verma',
  reason: 'Q2 scope extension',
  effective_from: '2026-05-01T00:00:00.000Z',
  effective_to: '2026-06-01T00:00:00.000Z',
}

describe('TopupLog', () => {
  // #633: the period is UTC days; the end is the last day included.
  it('shows each top-up\'s period in UTC days and when it was added', () => {
    const wrapper = mount(TopupLog, { props: { topups: [sampleTopup] } })
    expect(wrapper.find('[data-testid="topup-period"]').text()).toBe('1 to 31 May 2026')
    expect(wrapper.text()).toContain('Added by Anil Verma, ')
    expect(wrapper.text()).not.toMatch(/\+00|\[/)
  })

  // #633: the default period is the server's month, not the browser's.
  it('defaults the new top-up to the server\'s current UTC month', async () => {
    const wrapper = mount(TopupLog, { props: { topups: [] } })
    await wrapper.find('[data-testid="topup-toggle"]').trigger('click')
    expect((wrapper.find('[data-testid="topup-from"]').element as HTMLInputElement).value).toBe('2026-10-01')
    expect((wrapper.find('[data-testid="topup-to"]').element as HTMLInputElement).value).toBe('2026-11-01')
    expect(wrapper.text()).toContain('Until (UTC, not included)')
  })

  it('a deep link focuses the amount once the clock arrives after mount (Copilot, PR 639)', async () => {
    const clock = stubServerClock(null)
    const wrapper = mount(TopupLog, { props: { topups: [], initiallyExpanded: true }, attachTo: document.body })
    await nextTick()
    expect(wrapper.find('[data-testid="topup-amount"]').exists()).toBe(false)
    clock.value.value = resolveServerClock(new Date('2026-10-15T12:00:00Z'))
    await nextTick()
    await nextTick()
    await nextTick()
    const amount = wrapper.find('[data-testid="topup-amount"]')
    expect(amount.exists()).toBe(true)
    expect(document.activeElement).toBe(amount.element)
    wrapper.unmount()
  })

  it('cancelling while the clock is pending does not spend the deep link', async () => {
    const clock = stubServerClock(null)
    const wrapper = mount(TopupLog, { props: { topups: [], initiallyExpanded: true }, attachTo: document.body })
    await wrapper.find('[data-testid="topup-toggle"]').trigger('click') // cancel
    clock.value.value = resolveServerClock(new Date('2026-10-15T12:00:00Z'))
    await nextTick()
    await nextTick()
    await wrapper.find('[data-testid="topup-toggle"]').trigger('click') // reopen
    await nextTick()
    await nextTick()
    const amount = wrapper.find('[data-testid="topup-amount"]')
    expect(amount.exists()).toBe(true)
    expect(document.activeElement).toBe(amount.element)
    wrapper.unmount()
  })

  it('a failed clock read says so and offers a retry, keeping the form hidden', async () => {
    const clock = stubServerClock(null)
    clock.error.value = new Error('clock down')
    const wrapper = mount(TopupLog, { props: { topups: [], initiallyExpanded: true } })
    expect(wrapper.find('[data-testid="topup-form"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="topup-clock-error"]').exists()).toBe(true)
    await wrapper.find('[data-testid="topup-clock-retry"]').trigger('click')
    expect(clock.refresh).toHaveBeenCalled()
  })

  it('opens the form only once the server clock has answered', async () => {
    stubServerClock(null)
    const wrapper = mount(TopupLog, { props: { topups: [] } })
    await wrapper.find('[data-testid="topup-toggle"]').trigger('click')
    expect(wrapper.find('[data-testid="topup-form"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="topup-form-waiting"]').exists()).toBe(true)
  })

  it('renders top-up rows without Edit/Delete controls', () => {
    const wrapper = mount(TopupLog, { props: { topups: [sampleTopup] } })
    const html = wrapper.html()
    expect(html).toContain('Q2 scope extension')
    expect(html).toContain('+$500.00')
    expect(html).not.toMatch(/\bEdit\b/i)
    expect(html).not.toMatch(/\bDelete\b/i)
    expect(html).not.toMatch(/\bRemove\b/i)
  })

  it('inline form submit emits `add` with a structured payload', async () => {
    const wrapper = mount(TopupLog, { props: { topups: [] } })
    await wrapper.find('[data-testid="topup-toggle"]').trigger('click')
    await wrapper.find('[data-testid="topup-amount"]').setValue('250.50')
    await wrapper.find('[data-testid="topup-from"]').setValue('2026-06-01')
    await wrapper.find('[data-testid="topup-to"]').setValue('2026-07-01')
    await wrapper.find('[data-testid="topup-reason"]').setValue('Reseed')
    // Trigger the form's submit handler directly — happy-dom doesn't
    // bubble button.click() to the parent form's @submit.
    await wrapper.find('[data-testid="topup-form"]').trigger('submit')
    const evt = wrapper.emitted('add')
    expect(evt).toBeDefined()
    expect(evt![0]).toEqual([
      {
        budget_usd: '250.50',
        effective_from: '2026-06-01',
        effective_to: '2026-07-01',
        reason: 'Reseed',
      },
    ])
  })

  it('submit is disabled when budget is non-numeric', async () => {
    const wrapper = mount(TopupLog, { props: { topups: [] } })
    await wrapper.find('[data-testid="topup-toggle"]').trigger('click')
    await wrapper.find('[data-testid="topup-amount"]').setValue('not-a-number')
    await wrapper.find('[data-testid="topup-from"]').setValue('2026-06-01')
    await wrapper.find('[data-testid="topup-to"]').setValue('2026-07-01')
    const submit = wrapper.find('[data-testid="topup-submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
  })

  it('submit is disabled when the date range is degenerate (from >= to)', async () => {
    const wrapper = mount(TopupLog, { props: { topups: [] } })
    await wrapper.find('[data-testid="topup-toggle"]').trigger('click')
    await wrapper.find('[data-testid="topup-amount"]').setValue('100.00')
    await wrapper.find('[data-testid="topup-from"]').setValue('2026-07-01')
    await wrapper.find('[data-testid="topup-to"]').setValue('2026-06-01')
    const submit = wrapper.find('[data-testid="topup-submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
  })

  /*
   * FE-6: the child must not discard the user's input before the server
   * accepted it — reset/collapse only after the parent's `submitting` flips
   * back to false with no `submitError`.
   */
  describe('parent-signalled success/failure (FE-6)', () => {
    function mountTopup(props: { topups: TopupRow[]; submitting?: boolean; submitError?: string | null }) {
      return mount(TopupLog, { props })
    }

    async function fillAndSubmit(wrapper: ReturnType<typeof mountTopup>) {
      await wrapper.find('[data-testid="topup-toggle"]').trigger('click')
      await wrapper.find('[data-testid="topup-amount"]').setValue('250.50')
      await wrapper.find('[data-testid="topup-from"]').setValue('2026-06-01')
      await wrapper.find('[data-testid="topup-to"]').setValue('2026-07-01')
      await wrapper.find('[data-testid="topup-reason"]').setValue('Reseed')
      await wrapper.find('[data-testid="topup-form"]').trigger('submit')
    }

    it('keeps the form (and its values) until the parent signals success', async () => {
      const wrapper = mountTopup({ topups: [], submitting: false })
      await fillAndSubmit(wrapper)
      // Emitted, but the parent has not resolved yet — input must survive.
      expect(wrapper.emitted('add')).toHaveLength(1)
      const amount = wrapper.find('[data-testid="topup-amount"]')
      expect(amount.exists()).toBe(true)
      expect((amount.element as HTMLInputElement).value).toBe('250.50')

      // Parent: submitting → true → false with no error = success.
      await wrapper.setProps({ submitting: true })
      await wrapper.setProps({ submitting: false })
      // Form collapsed (reset + collapse on success).
      expect(wrapper.find('[data-testid="topup-form"]').exists()).toBe(false)
    })

    it('on failure keeps the input visible and shows the error', async () => {
      const wrapper = mountTopup({ topups: [], submitting: false })
      await fillAndSubmit(wrapper)
      await wrapper.setProps({ submitting: true })
      await wrapper.setProps({ submitting: false, submitError: 'Budget overlaps.' })

      const amount = wrapper.find('[data-testid="topup-amount"]')
      expect(amount.exists()).toBe(true)
      expect((amount.element as HTMLInputElement).value).toBe('250.50')
      const error = wrapper.find('[data-testid="topup-error"]')
      expect(error.exists()).toBe(true)
      expect(error.text()).toContain('Budget overlaps.')
    })

    it('locks the submit button while the parent POST is in flight', async () => {
      const wrapper = mountTopup({ topups: [], submitting: false })
      await fillAndSubmit(wrapper)
      await wrapper.setProps({ submitting: true })
      const submit = wrapper.find('[data-testid="topup-submit"]')
      expect(submit.attributes('disabled')).toBeDefined()
      expect(submit.text()).toContain('Adding…')
      // A second form submit while in flight must not re-emit.
      await wrapper.find('[data-testid="topup-form"]').trigger('submit')
      expect(wrapper.emitted('add')).toHaveLength(1)
    })
  })
})
