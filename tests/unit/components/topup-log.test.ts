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
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import TopupLog, { type TopupRow } from '../../../app/components/allocator/TopupLog.vue'

const sampleTopup: TopupRow = {
  id: 't1',
  budget_usd: '500.00',
  effective: '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)',
  created_at: '2026-05-15T10:00:00Z',
  actor_display_name: 'Anil Verma',
  reason: 'Q2 scope extension',
}

describe('TopupLog', () => {
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
