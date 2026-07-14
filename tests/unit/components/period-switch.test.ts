/*
 * UiPeriodSwitch — segmented control state transitions.
 *
 * v-model contract: selecting an already-selected key is a no-op
 * (no emit); selecting a new key emits the new key once.
 */
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UiPeriodSwitch from '../../../app/components/ui/PeriodSwitch.vue'

describe('UiPeriodSwitch', () => {
  it('emits update:modelValue when a new option is clicked', async () => {
    const wrapper = mount(UiPeriodSwitch, {
      props: { modelValue: 'mtd' },
    })
    const buttons = wrapper.findAll('button')
    expect(buttons.length).toBe(4)
    await buttons[1]!.trigger('click') // 7d
    const evt = wrapper.emitted('update:modelValue')
    expect(evt).toBeDefined()
    expect(evt![0]).toEqual(['7d'])
  })

  it('does not emit when the current selection is re-clicked', async () => {
    const wrapper = mount(UiPeriodSwitch, {
      props: { modelValue: 'mtd' },
    })
    const buttons = wrapper.findAll('button')
    await buttons[0]!.trigger('click') // mtd (already selected)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('accepts custom options', async () => {
    const wrapper = mount(UiPeriodSwitch, {
      props: {
        modelValue: 'q1',
        options: [
          { key: 'q1', label: 'Q1 2026' },
          { key: 'custom', label: 'Custom…' },
        ],
      },
    })
    const buttons = wrapper.findAll('button')
    expect(buttons.length).toBe(2)
    await buttons[1]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual(['custom'])
  })
})
