// @vitest-environment happy-dom
/*
 * AllocatorModeToggle — state transition unit test.
 *
 * "shared-pool" → click "per-dev-fixed" now emits the per-dev mode:
 * per-developer fixed budgets shipped with the MVP-path journey (project
 * onboarding → members → individual caps), so the card is selectable.
 * Re-clicking the same selected card re-emits (no dedupe).
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AllocatorModeToggle from '../../../app/components/allocator/AllocatorModeToggle.vue'

describe('AllocatorModeToggle', () => {
  it('renders both cards with the selected one highlighted', async () => {
    const wrapper = mount(AllocatorModeToggle, {
      props: { modelValue: 'shared-pool' },
    })
    expect(wrapper.find('[data-testid="mode-shared-pool"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mode-per-dev-fixed"]').exists()).toBe(true)
    // Selected pill renders on the active card.
    expect(wrapper.find('[data-testid="mode-shared-pool"]').text()).toContain('Selected')
  })

  it('clicking per-dev-fixed emits update:modelValue (now selectable)', async () => {
    const wrapper = mount(AllocatorModeToggle, {
      props: { modelValue: 'shared-pool' },
    })
    await wrapper.find('[data-testid="mode-per-dev-fixed"]').trigger('click')
    const evt = wrapper.emitted('update:modelValue')
    expect(evt).toBeDefined()
    expect(evt![0]).toEqual(['per-dev-fixed'])
  })

  it('clicking the already-selected card re-emits the same value (idempotent)', async () => {
    const wrapper = mount(AllocatorModeToggle, {
      props: { modelValue: 'shared-pool' },
    })
    await wrapper.find('[data-testid="mode-shared-pool"]').trigger('click')
    // Idempotent re-click DOES emit — toggle doesn't dedupe; v-model
    // upstream handles. This matches simple radio behaviour.
    const evt = wrapper.emitted('update:modelValue')
    expect(evt).toBeDefined()
    expect(evt![0]).toEqual(['shared-pool'])
  })
})
